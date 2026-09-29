#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "kb.h"

/** Linux signal numbers (the same on both guests) to the host's; 0 for none */
int kb_host_sig(int s) {
    switch (s) {
        case 1: return SIGHUP;
        case 2: return SIGINT;
        case 3: return SIGQUIT;
        case 4: return SIGILL;
        case 5: return SIGTRAP;
        case 6: return SIGABRT;
        case 7: return SIGBUS;
        case 8: return SIGFPE;
        case 9: return SIGKILL;
        case 10: return SIGUSR1;
        case 11: return SIGSEGV;
        case 12: return SIGUSR2;
        case 13: return SIGPIPE;
        case 14: return SIGALRM;
        case 15: return SIGTERM;
        case 17: return SIGCHLD;
        case 18: return SIGCONT;
        case 19: return SIGSTOP;
        case 20: return SIGTSTP;
        case 21: return SIGTTIN;
        case 22: return SIGTTOU;
        case 23: return SIGURG;
        case 24: return SIGXCPU;
        case 25: return SIGXFSZ;
        case 26: return SIGVTALRM;
        case 27: return SIGPROF;
        case 28: return SIGWINCH;
        default: return 0;
    }
}

static int guest_sig(int h) {
    for (int s = 1; s < 32; s++)
        if (kb_host_sig(s) == h) return s;
    return 0;
}

static volatile sig_atomic_t pending_bits[65];
static int pending_code[65]; /* si_code: SI_USER 0 from kill and other
                                processes, SI_TKILL -6 */
static volatile sig_atomic_t any_pending;
volatile int* kb_pending_flag = &any_pending;

static int timer_sig; /* the guest's one POSIX timer, on the host's ITIMER_REAL;
                         0 for none */

#ifdef KB_COUNT
static volatile uint64_t raised_ns;

static uint64_t now_ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t) t.tv_sec * 1000000000ull + (uint64_t) t.tv_nsec;
}
#endif

static void on_host_signal(int h) {
    int s = h == SIGALRM && timer_sig ? timer_sig : guest_sig(h);
#ifdef KB_COUNT
    if (s && !raised_ns) raised_ns = now_ns();
#endif
    if (s) {
        pending_code[s] = 0;
        pending_bits[s] = 1;
        any_pending = 1;
    }
}

/* default actions: ignore for these, terminate (by the host signal itself) for
 * the rest */
static int ignored_by_default(int s) {
    return s == 17 || s == 18 || s == 23 || s == 28;
}

static void terminate(struct kb_cpu* cpu, int s) {
    if (cpu->trace) fflush(cpu->trace);
    if (getenv("KATYBUG_DEBUG")) {
        uint8_t* p = kb_host(cpu, cpu->ipc, 8);
        fprintf(
            kb_log, "katybug: signal %d (%s) at %#llx", s,
            cpu->last_fault ? cpu->last_fault : "sent",
            (unsigned long long) cpu->ipc
        );
        for (int i = 0; p && i < 8; i++) fprintf(kb_log, " %02x", p[i]);
        fprintf(
            kb_log, " address %#llx after %llu blocks\n",
            (unsigned long long) cpu->fault_addr,
            (unsigned long long) cpu->steps
        );
    }
    int h = kb_host_sig(s);
    if (h) {
        signal(h, SIG_DFL);
        sigset_t set;
        sigemptyset(&set);
        sigaddset(&set, h);
        sigprocmask(SIG_UNBLOCK, &set, NULL);
        raise(h);
    }
    cpu->exited = 1;
    cpu->status = 128 + s;
}

static void host_install(struct kb_cpu* cpu, int s);

int64_t kb_sigaction(struct kb_cpu* cpu, int s, uint64_t act, uint64_t old) {
    if (s < 1 || s > 64 || s == 9 || s == 19) return -22;
    struct kb_sigaction* a = &cpu->sig[s];
    if (old) {
        kb_store(cpu, old, a->handler, 8);
        kb_store(cpu, old + 8, a->flags, 8);
        kb_store(cpu, old + 16, a->restorer, 8);
        kb_store(cpu, old + 24, a->mask, 8);
    }
    if (!act) return 0;
    a->handler = kb_load(cpu, act, 8);
    a->flags = kb_load(cpu, act + 8, 8);
    a->restorer = kb_load(cpu, act + 16, 8);
    a->mask = kb_load(cpu, act + 24, 8);
    host_install(cpu, s);
    return 0;
}

/** at exec: a signal the host process inherited as ignored stays ignored for
 * the guest, as execve keeps it */
void kb_sig_inherit(struct kb_cpu* cpu) {
    for (int s = 1; s <= 64; s++) {
        int h = kb_host_sig(s);
        struct sigaction hs;
        if (h && sigaction(h, NULL, &hs) == 0 && hs.sa_handler == SIG_IGN)
            cpu->sig[s].handler = 1;
    }
}

/** after kb_resume: the host handlers for the guest's, which exec reset */
void kb_sig_reinstall(struct kb_cpu* cpu) {
    for (int s = 1; s <= 64; s++)
        if (cpu->sig[s].handler > 1) host_install(cpu, s);
}

static void host_install(struct kb_cpu* cpu, int s) {
    struct kb_sigaction* a = &cpu->sig[s];
    int h = kb_host_sig(s);
    if (!h || s == 11 || s == 8 || s == 4 || s == 7)
        return; /* faults are raised by katybug */
    struct sigaction hs;
    memset(&hs, 0, sizeof hs);
    if (a->handler == 0)
        hs.sa_handler = SIG_DFL;
    else if (a->handler == 1)
        hs.sa_handler = SIG_IGN;
    else {
        /* never SA_RESTART: a blocked host call must return for the guest
         * handler to run; kb_restart re-issues it as Linux would */
        hs.sa_handler = on_host_signal;
    }
    sigfillset(&hs.sa_mask);
    sigaction(h, &hs, NULL);
}

int64_t kb_sigprocmask(
    struct kb_cpu* cpu, int how, uint64_t set, uint64_t old
) {
    if (old) kb_store(cpu, old, cpu->sigmask, 8);
    if (!set) return 0;
    uint64_t m = kb_load(cpu, set, 8);
    if (how == 0)
        cpu->sigmask |= m;
    else if (how == 1)
        cpu->sigmask &= ~m;
    else if (how == 2)
        cpu->sigmask = m;
    else
        return -22;
    cpu->sigmask &=
        ~((1ull << 8) | (1ull << 18)); /* sigkill and sigstop never block */
    return 0;
}

/* a signal sent to this process: pending until unmasked; faults are delivered
 * at once */
void kb_raise(struct kb_cpu* cpu, int s, int code) {
    if (s < 1 || s > 64) return;
    pending_code[s] = code;
    pending_bits[s] = 1;
    any_pending = 1;
    (void) cpu;
}

/* x86 rflags from the flag bits, and back */
static uint64_t rflags(struct kb_cpu* cpu) {
    return 0x202 | (uint64_t) cpu->c | ((uint64_t) cpu->p << 2) |
           ((uint64_t) cpu->z << 6) | ((uint64_t) cpu->n << 7) |
           ((uint64_t) cpu->v << 11);
}

static void set_rflags(struct kb_cpu* cpu, uint64_t f) {
    cpu->c = (int) (f & 1);
    cpu->p = (int) ((f >> 2) & 1);
    cpu->z = (int) ((f >> 6) & 1);
    cpu->n = (int) ((f >> 7) & 1);
    cpu->v = (int) ((f >> 11) & 1);
}

/* the kernel's sigcontext order for x86-64: r8..r15, rdi, rsi, rbp, rbx, rdx,
 * rax, rcx, rsp, rip */
static const int x86_order[17] = {8, 9, 10, 11, 12, 13, 14, 15, 7,
                                  6, 5, 3,  2,  0,  1,  4,  -1};

/** x86 fxsave, for a signal frame and the instruction: fcw, fsw, abridged
 * tags, mxcsr at 24, st(i) at 32 in 16-byte slots, xmm at 160 */
void kb_fxsave(struct kb_cpu* cpu, uint64_t fp) {
    for (uint64_t i = 0; i < 512; i += 8) kb_store(cpu, fp + i, 0, 8);
    kb_store(cpu, fp, cpu->fcw, 2);
    kb_store(cpu, fp + 2, (uint64_t) (cpu->fcc | (cpu->top << 11)), 2);
    kb_store(cpu, fp + 4, cpu->ftag, 1);
    kb_store(cpu, fp + 24, cpu->mxcsr, 4);
    kb_store(cpu, fp + 28, 0xffff, 4);
    for (int i = 0; i < 8; i++) {
        f80 v = cpu->st[(cpu->top + i) & 7];
        kb_store(cpu, fp + 32 + 16 * (uint64_t) i, v.sig, 8);
        kb_store(cpu, fp + 40 + 16 * (uint64_t) i, v.se, 2);
    }
    for (int i = 0; i < 16; i++)
        for (int h = 0; h < 2; h++)
            kb_store(
                cpu, fp + 160 + 16 * (uint64_t) i + 8 * (uint64_t) h,
                cpu->x[i][h], 8
            );
}

void kb_fxrstor(struct kb_cpu* cpu, uint64_t fp) {
    cpu->fcw = (uint16_t) kb_load(cpu, fp, 2);
    cpu->mxcsr = (uint32_t) kb_load(cpu, fp + 24, 4) & 0xffff;
    uint16_t sw = (uint16_t) kb_load(cpu, fp + 2, 2);
    cpu->fcc = sw & 0x4700;
    cpu->top = (sw >> 11) & 7;
    cpu->ftag = (uint8_t) kb_load(cpu, fp + 4, 1);
    for (int i = 0; i < 8; i++) {
        f80* v = &cpu->st[(cpu->top + i) & 7];
        v->sig = kb_load(cpu, fp + 32 + 16 * (uint64_t) i, 8);
        v->se = (uint16_t) kb_load(cpu, fp + 40 + 16 * (uint64_t) i, 2);
    }
    for (int i = 0; i < 16; i++)
        for (int h = 0; h < 2; h++)
            cpu->x[i][h] = kb_load(
                cpu, fp + 160 + 16 * (uint64_t) i + 8 * (uint64_t) h, 8
            );
}

/* AArch64: sigcontext's __reserved (after pstate, 16-aligned) holds records;
 * the first is fpsimd_context: magic, size 528, fpsr, fpcr, v0-v31 at 16 */
#define A64_RESERVED (8 + 8 * 34 + 8)
#define A64_FPSIMD 0x46508001u

static void deliver(struct kb_cpu* cpu, int s, int code, uint64_t addr) {
    KB_SYNC(cpu); /* the frame carries the flag bits */
    struct kb_sigaction* a = &cpu->sig[s];
    uint64_t* r = cpu->r;
    uint64_t frame;
    if (cpu->arch == KB_X86) {
        /* pretcode, then ucontext (uc_flags, uc_link, uc_stack[3],
         * mcontext[32], sigmask), then siginfo */
        uint64_t sp = (r[4] - 128) & ~15ull; /* the red zone */
        uint64_t fp = (sp - 512) & ~63ull;   /* fpstate, above the frame */
        uint64_t uc_size = 8 * (5 + 32 + 1);
        frame = ((fp - 128 - uc_size - 8) & ~15ull) - 8;
        uint64_t uc = frame + 8, info = uc + uc_size;
        kb_store(cpu, frame, a->restorer, 8);
        for (uint64_t i = 0; i < uc_size; i += 8) kb_store(cpu, uc + i, 0, 8);
        uint64_t mc = uc + 40;
        kb_fxsave(cpu, fp);
        kb_store(cpu, mc + 8 * 23, fp, 8);
        for (int i = 0; i < 16; i++)
            kb_store(cpu, mc + 8 * (uint64_t) i, r[x86_order[i]], 8);
        kb_store(cpu, mc + 8 * 16, cpu->pc, 8);
        kb_store(cpu, mc + 8 * 17, rflags(cpu), 8);
        kb_store(
            cpu, uc + 40 + 8 * 32,
            cpu->restore_mask ? cpu->saved_mask : cpu->sigmask, 8
        );
        for (uint64_t i = 0; i < 128; i += 8) kb_store(cpu, info + i, 0, 8);
        kb_store(cpu, info, (uint64_t) s, 4);
        kb_store(cpu, info + 8, (uint64_t) (uint32_t) code, 4);
        kb_store(cpu, info + 16, addr, 8);
        r[7] = (uint64_t) s;
        r[6] = info;
        r[2] = uc;
        r[4] = frame;
        r[0] = 0;
    }
    else {
        /* siginfo, then ucontext: uc_flags, uc_link, uc_stack[3], sigmask[16],
         * mcontext (16-aligned) */
        uint64_t sp = r[31] & ~15ull;
        uint64_t mc_off = 8 * 5 + 128; /* 168, aligned below */
        mc_off = (mc_off + 15) & ~15ull;
        uint64_t uc_size = mc_off + A64_RESERVED + 4096;
        frame = (sp - 128 - uc_size) & ~15ull;
        uint64_t info = frame, uc = frame + 128;
        for (uint64_t i = 0; i < 128 + uc_size; i += 8)
            kb_store(cpu, frame + i, 0, 8);
        kb_store(cpu, info, (uint64_t) s, 4);
        kb_store(cpu, info + 8, (uint64_t) (uint32_t) code, 4);
        kb_store(cpu, info + 16, addr, 8);
        kb_store(
            cpu, uc + 40, cpu->restore_mask ? cpu->saved_mask : cpu->sigmask, 8
        );
        uint64_t mc = uc + mc_off;
        kb_store(cpu, mc, addr, 8);
        for (int i = 0; i < 31; i++)
            kb_store(cpu, mc + 8 + 8 * (uint64_t) i, r[i], 8);
        kb_store(cpu, mc + 8 + 8 * 31, r[31], 8);
        kb_store(cpu, mc + 8 + 8 * 32, cpu->pc, 8);
        uint64_t nzcv = ((uint64_t) cpu->n << 31) | ((uint64_t) cpu->z << 30) |
                        ((uint64_t) cpu->c << 29) | ((uint64_t) cpu->v << 28);
        kb_store(cpu, mc + 8 + 8 * 33, nzcv, 8);
        uint64_t fs = mc + A64_RESERVED;
        kb_store(cpu, fs, A64_FPSIMD, 4);
        kb_store(cpu, fs + 4, 528, 4);
        kb_store(cpu, fs + 8, cpu->fpsr, 4);
        kb_store(cpu, fs + 12, cpu->fpcr, 4);
        for (int i = 0; i < 32; i++)
            for (int h = 0; h < 2; h++)
                kb_store(
                    cpu, fs + 16 + 16 * (uint64_t) i + 8 * (uint64_t) h,
                    cpu->x[i][h], 8
                );
        r[0] = (uint64_t) s;
        r[1] = info;
        r[2] = uc;
        r[30] = (a->flags & 0x04000000) ? a->restorer : KB_A64_SIGTRAMP;
        r[31] = frame;
    }
    cpu->restore_mask = 0;
    cpu->excl = ~0ull; /* an exception return clears the exclusive monitor */
    cpu->sigmask |= a->mask;
    if (!(a->flags & 0x40000000))
        cpu->sigmask |= 1ull << (s - 1);       /* SA_NODEFER */
    if (a->flags & 0x80000000) a->handler = 0; /* SA_RESETHAND */
    cpu->pc = a->handler;
}

/* rt_sigreturn: the handler's frame is at the stack pointer (x86: past the
 * popped pretcode) */
void kb_sigreturn(struct kb_cpu* cpu) {
    uint64_t* r = cpu->r;
    cpu->lz = 0; /* the frame's flags replace them all */
    if (cpu->arch == KB_X86) {
        uint64_t uc = r[4], mc = uc + 40;
        uint64_t regs[18];
        for (int i = 0; i < 18; i++)
            regs[i] = kb_load(cpu, mc + 8 * (uint64_t) i, 8);
        for (int i = 0; i < 16; i++) r[x86_order[i]] = regs[i];
        cpu->pc = regs[16];
        set_rflags(cpu, regs[17]);
        uint64_t fp = kb_load(cpu, mc + 8 * 23, 8);
        if (fp) kb_fxrstor(cpu, fp);
        cpu->sigmask = kb_load(cpu, uc + 40 + 8 * 32, 8);
    }
    else {
        uint64_t uc = r[31] + 128;
        uint64_t mc = uc + ((8 * 5 + 128 + 15) & ~15ull);
        for (int i = 0; i < 31; i++)
            r[i] = kb_load(cpu, mc + 8 + 8 * (uint64_t) i, 8);
        r[31] = kb_load(cpu, mc + 8 + 8 * 31, 8);
        cpu->pc = kb_load(cpu, mc + 8 + 8 * 32, 8);
        uint64_t nzcv = kb_load(cpu, mc + 8 + 8 * 33, 8);
        cpu->n = (int) ((nzcv >> 31) & 1);
        cpu->z = (int) ((nzcv >> 30) & 1);
        cpu->c = (int) ((nzcv >> 29) & 1);
        cpu->v = (int) ((nzcv >> 28) & 1);
        uint64_t fs = mc + A64_RESERVED;
        if ((uint32_t) kb_load(cpu, fs, 4) == A64_FPSIMD) {
            cpu->fpsr = (uint32_t) kb_load(cpu, fs + 8, 4) & 0x0800009f;
            cpu->fpcr = (uint32_t) kb_load(cpu, fs + 12, 4) & 0x07ff9f00;
            for (int i = 0; i < 32; i++)
                for (int h = 0; h < 2; h++)
                    cpu->x[i][h] = kb_load(
                        cpu, fs + 16 + 16 * (uint64_t) i + 8 * (uint64_t) h, 8
                    );
        }
        cpu->sigmask = kb_load(cpu, uc + 40, 8);
    }
    cpu->sigreturned = 1;
}

static void deliver_one(struct kb_cpu* cpu);

/* delivers the lowest pending unmasked signal, if any; called between blocks */
void kb_signals(struct kb_cpu* cpu) {
    deliver_one(cpu);
    if (cpu->restore_mask) {
        cpu->sigmask = cpu->saved_mask;
        cpu->restore_mask = 0;
    }
}

/* a pending signal the mask lets through that would run a handler or end the
 * process */
static int deliverable(struct kb_cpu* cpu) {
    for (int s = 1; s <= 64; s++) {
        if (!pending_bits[s] || (cpu->sigmask & (1ull << (s - 1)))) continue;
        uint64_t h = cpu->sig[s].handler;
        if (h > 1 || (h == 0 && !ignored_by_default(s))) return 1;
    }
    return 0;
}

/** a host call ended with EINTR: 1 when the guest sees it restarted, because
   no handler will run (the signal is masked or ignored) or the one that runs
   asked for SA_RESTART on a call Linux restarts */
int kb_restart(struct kb_cpu* cpu, int restartable) {
    for (int s = 1; s <= 64; s++) {
        if (!pending_bits[s] || (cpu->sigmask & (1ull << (s - 1)))) continue;
        if (cpu->sig[s].handler <= 1) continue;
        return restartable && (cpu->sig[s].flags & 0x10000000);
    }
    return 1;
}

/** rt_sigsuspend: waits under the given mask for a signal to act on, then
   returns EINTR; the handler's frame carries the caller's mask so sigreturn
   restores it */
int64_t kb_sigsuspend(struct kb_cpu* cpu, uint64_t mask) {
    uint64_t old = cpu->sigmask;
    cpu->sigmask = mask & ~((1ull << 8) | (1ull << 18));
    sigset_t all, none, prev;
    sigfillset(&all);
    sigemptyset(&none);
    sigprocmask(SIG_BLOCK, &all, &prev);
    while (!deliverable(cpu)) sigsuspend(&none);
    sigprocmask(SIG_SETMASK, &prev, NULL);
    cpu->saved_mask = old;
    cpu->restore_mask = 1;
    return -4;
}

int64_t kb_sigpending(struct kb_cpu* cpu, uint64_t set) {
    uint64_t m = 0;
    for (int s = 1; s <= 64; s++)
        if (pending_bits[s]) m |= 1ull << (s - 1);
    kb_store(cpu, set, m & cpu->sigmask, 8);
    return 0;
}

static void get_ts(struct kb_cpu* cpu, uint64_t va, struct timeval* tv) {
    tv->tv_sec = (time_t) kb_load(cpu, va, 8);
    tv->tv_usec = (suseconds_t) ((kb_load(cpu, va + 8, 8) + 999) / 1000);
}

static void put_itimer(
    struct kb_cpu* cpu, uint64_t va, const struct itimerval* v, int nano
) {
    uint64_t k = nano ? 1000 : 1;
    kb_store(cpu, va, (uint64_t) v->it_interval.tv_sec, 8);
    kb_store(cpu, va + 8, (uint64_t) v->it_interval.tv_usec * k, 8);
    kb_store(cpu, va + 16, (uint64_t) v->it_value.tv_sec, 8);
    kb_store(cpu, va + 24, (uint64_t) v->it_value.tv_usec * k, 8);
}

/** getitimer, setitimer, alarm (-6) and one POSIX timer (timer_create,
   _settime, _gettime, _getoverrun, _delete), all on the host's ITIMER_REAL;
   generic syscall numbers */
int64_t kb_timer(struct kb_cpu* cpu, int64_t nr, const uint64_t* a) {
    struct itimerval nv, ov;
    switch (nr) {
        case -6: return (int64_t) alarm((unsigned) a[0]);
        case 102:
            if (a[0] != 0) return -22;
            getitimer(ITIMER_REAL, &ov);
            put_itimer(cpu, a[1], &ov, 0);
            return 0;
        case 103:
            if (a[0] != 0) return -22;
            nv.it_interval.tv_sec = (time_t) kb_load(cpu, a[1], 8);
            nv.it_interval.tv_usec = (suseconds_t) kb_load(cpu, a[1] + 8, 8);
            nv.it_value.tv_sec = (time_t) kb_load(cpu, a[1] + 16, 8);
            nv.it_value.tv_usec = (suseconds_t) kb_load(cpu, a[1] + 24, 8);
            if (setitimer(ITIMER_REAL, &nv, &ov) < 0) return kb_err(errno);
            if (a[2]) put_itimer(cpu, a[2], &ov, 0);
            return 0;
        case 107: /* timer_create(clock, sigevent or NULL, id): SIGEV_SIGNAL
                     only */
        {
            if (timer_sig) return -11;
            int sig = 14;
            if (a[1]) {
                if (kb_load(cpu, a[1] + 12, 4) != 0) return -22;
                sig = (int) kb_load(cpu, a[1] + 8, 4);
            }
            if (sig < 1 || sig > 64) return -22;
            timer_sig = sig;
            struct sigaction hs;
            memset(&hs, 0, sizeof hs);
            hs.sa_handler = on_host_signal;
            sigfillset(&hs.sa_mask);
            sigaction(SIGALRM, &hs, NULL);
            kb_store(cpu, a[2], 0, 4);
            return 0;
        }
        case 110: /* timer_settime(id, flags, new, old) */
        {
            if (!timer_sig || a[0] != 0) return -22;
            get_ts(cpu, a[2], &nv.it_interval);
            get_ts(cpu, a[2] + 16, &nv.it_value);
            if ((a[1] & 1) &&
                (nv.it_value.tv_sec || nv.it_value.tv_usec)) /* TIMER_ABSTIME */
            {
                struct timespec now;
                clock_gettime(CLOCK_REALTIME, &now);
                int64_t us =
                    ((int64_t) nv.it_value.tv_sec - now.tv_sec) * 1000000 +
                    nv.it_value.tv_usec - now.tv_nsec / 1000;
                if (us < 1) us = 1;
                nv.it_value.tv_sec = (time_t) (us / 1000000);
                nv.it_value.tv_usec = (suseconds_t) (us % 1000000);
            }
            if (setitimer(ITIMER_REAL, &nv, &ov) < 0) return kb_err(errno);
            if (a[3]) put_itimer(cpu, a[3], &ov, 1);
            return 0;
        }
        case 108:
            if (!timer_sig || a[0] != 0) return -22;
            getitimer(ITIMER_REAL, &ov);
            put_itimer(cpu, a[1], &ov, 1);
            return 0;
        case 109: return timer_sig && a[0] == 0 ? 0 : -22;
        case 111:
            if (!timer_sig || a[0] != 0) return -22;
            memset(&nv, 0, sizeof nv);
            setitimer(ITIMER_REAL, &nv, NULL);
            timer_sig = 0;
            return 0;
    }
    return -38;
}

static void deliver_one(struct kb_cpu* cpu) {
    if (!any_pending) return;
    any_pending = 0;
#ifdef KB_COUNT
    if (raised_ns) {
        uint64_t d = now_ns() - raised_ns;
        raised_ns = 0;
        kb_count.lat_n++;
        kb_count.lat_sum += d;
        if (d > kb_count.lat_max) kb_count.lat_max = d;
    }
#endif
    for (int s = 1; s <= 64; s++) {
        if (!pending_bits[s]) continue;
        if (cpu->sigmask & (1ull << (s - 1))) {
            any_pending = 1;
            continue;
        }
        pending_bits[s] = 0;
        uint64_t h = cpu->sig[s].handler;
        if (h == 1 || (h == 0 && ignored_by_default(s))) continue;
        if (h == 0) {
            terminate(cpu, s);
            return;
        }
        deliver(cpu, s, pending_code[s], 0);
        if (cpu->fault) {
            cpu->fault = NULL;
            terminate(cpu, 11);
        }
        return;
    }
}

/** a fault in the guest: its handler if it has one, else death by that signal
 */
int kb_fault(struct kb_cpu* cpu, int s, int code, uint64_t addr) {
    uint64_t h = cpu->sig[s].handler;
    if (h <= 1 || (cpu->sigmask & (1ull << (s - 1)))) {
        terminate(cpu, s);
        return 0;
    }
    cpu->fault_code = code;
    cpu->fault_addr = addr;
    deliver(cpu, s, code, addr);
    if (cpu->fault) /* the frame itself could not be written */
    {
        cpu->fault = NULL;
        terminate(cpu, 11);
        return 0;
    }
    return 1;
}
