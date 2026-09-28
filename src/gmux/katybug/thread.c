#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "kb.h"

/*
 * Guest threads run green, one at a time, inside this process (the host has
 * one thread per Katybug, as a Worker isolate does). kb_cpu holds the running
 * thread; the others wait here. A thread switches at a block boundary: every
 * KB_SLICE polls, when it waits on a futex, or when a call would block, which
 * parks it with the descriptors and deadline it waits for. So x86 locked ops
 * are atomic as they stand, and AArch64's exclusive monitor clears at a switch
 */

enum
{
    RUN,
    FUTEX, /* on a futex word until woken or the deadline */
    WAIT,  /* until a descriptor is ready or the deadline; then the call reruns
            */
    DEAD
};

struct kb_thread {
    uint64_t r[KB_NREGS], pc, fs, tpidr, x[32][2], sigmask, saved_mask;
    int n, z, c, v, p, df, top, restore_mask;
    uint32_t fpcr, fpsr, mxcsr;
    f80 st[8];
    uint8_t ftag;
    uint16_t fcw, fcc;
    int64_t tid;
    uint64_t clear_tid; /* CLONE_CHILD_CLEARTID: zeroed and woken at exit */
    int state;
    uint64_t word; /* a FUTEX thread's */
    uint32_t bitset;
    int64_t deadline; /* monotonic ns, or -1 */
    struct pollfd* fds;
    int nfds;
    uint64_t gate_pc; /* the call a WAIT thread reruns, and when it gives up */
    int64_t gate_deadline;
};

int kb_nthreads = 1;
uint64_t kb_switches;
static struct kb_thread* th;
static int nth, cur;
static int64_t tids;

static int64_t now_ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t) t.tv_sec * 1000000000 + t.tv_nsec;
}

static void save(struct kb_cpu* cpu, struct kb_thread* t) {
    KB_SYNC(cpu);
    memcpy(t->r, cpu->r, sizeof t->r);
    memcpy(t->x, cpu->x, sizeof t->x);
    memcpy(t->st, cpu->st, sizeof t->st);
    t->pc = cpu->pc, t->fs = cpu->fs, t->tpidr = cpu->tpidr;
    t->sigmask = cpu->sigmask, t->saved_mask = cpu->saved_mask;
    t->n = cpu->n, t->z = cpu->z, t->c = cpu->c, t->v = cpu->v, t->p = cpu->p;
    t->df = cpu->df, t->top = cpu->top, t->restore_mask = cpu->restore_mask;
    t->fpcr = cpu->fpcr, t->fpsr = cpu->fpsr, t->mxcsr = cpu->mxcsr;
    t->ftag = cpu->ftag, t->fcw = cpu->fcw, t->fcc = cpu->fcc;
}

static void load(struct kb_cpu* cpu, const struct kb_thread* t) {
    memcpy(cpu->r, t->r, sizeof t->r);
    memcpy(cpu->x, t->x, sizeof t->x);
    memcpy(cpu->st, t->st, sizeof t->st);
    cpu->pc = t->pc, cpu->fs = t->fs, cpu->tpidr = t->tpidr;
    cpu->sigmask = t->sigmask, cpu->saved_mask = t->saved_mask;
    cpu->n = t->n, cpu->z = t->z, cpu->c = t->c, cpu->v = t->v, cpu->p = t->p;
    cpu->df = t->df, cpu->top = t->top, cpu->restore_mask = t->restore_mask;
    cpu->fpcr = t->fpcr, cpu->fpsr = t->fpsr, cpu->mxcsr = t->mxcsr;
    cpu->ftag = t->ftag, cpu->fcw = t->fcw, cpu->fcc = t->fcc;
    cpu->excl = ~0ull;
    cpu->lz = 0;
}

/* the process's first thread, recorded when a second one starts */
static void ensure_main(void) {
    if (nth) return;
    th = calloc(8, sizeof *th);
    th[0].tid = getpid();
    th[0].deadline = -1;
    nth = 1;
    cur = 0;
}

/** in a forked child: only the calling thread goes on, as the child's main */
void kb_thread_forked(void) {
    for (int i = 0; i < nth; i++) free(th[i].fds);
    free(th);
    th = NULL;
    nth = cur = 0;
    kb_nthreads = 1;
}

int64_t kb_gettid(void) {
    return nth ? th[cur].tid : getpid();
}

/** a call finished: the next one at the same instruction (libcs share one
 * for every cancellable call) is a new call, with a deadline of its own */
void kb_thread_called(void) {
    if (nth) th[cur].gate_pc = 0;
}

/* the next runnable thread after the current one, the current one last */
static int pick(void) {
    for (int i = 1; i <= nth; i++) {
        int k = (cur + i) % nth;
        if (th[k].state == RUN) return k;
    }
    return -1;
}

/* waiting threads whose descriptor is ready or whose deadline passed go on;
 * with block, sleeps on the union of their descriptors until one does or a
 * signal comes (every live thread waits then) */
static void wait_all(int block) {
    int n = 0;
    for (int i = 0; i < nth; i++)
        if (th[i].state == WAIT) n += th[i].nfds;
    struct pollfd* all = calloc((size_t) n + 1, sizeof *all);
    int64_t soon = -1, t0 = now_ns();
    n = 0;
    for (int i = 0; i < nth; i++) {
        if (th[i].state == WAIT) {
            memcpy(all + n, th[i].fds, (size_t) th[i].nfds * sizeof *all);
            n += th[i].nfds;
        }
        if ((th[i].state == WAIT || th[i].state == FUTEX) &&
            th[i].deadline >= 0 && (soon < 0 || th[i].deadline < soon))
            soon = th[i].deadline;
    }
    int ms = !block       ? 0
             : soon < 0   ? -1
             : soon <= t0 ? 0
                          : (int) ((soon - t0 + 999999) / 1000000);
    if (!block && !n && soon < 0) {
        free(all);
        return;
    }
    int got = poll(all, (nfds_t) n, ms);
    int64_t t1 = now_ns();
    int woke = 0;
    n = 0;
    for (int i = 0; i < nth; i++) {
        struct kb_thread* t = &th[i];
        int ready = 0;
        if (t->state == WAIT) {
            for (int k = 0; k < t->nfds; k++) ready |= all[n + k].revents != 0;
            n += t->nfds;
        }
        if ((t->state == WAIT || t->state == FUTEX) &&
            (ready || (t->deadline >= 0 && t1 >= t->deadline))) {
            t->state = RUN; /* a FUTEX thread's r[0] already holds -110 */
            woke = 1;
        }
    }
    free(all);
    /* a signal: the first waiting thread takes it (a futex wait ends with
     * EINTR; a parked call reruns after the handler) */
    if (block && got < 0 && !woke)
        for (int i = 0; i < nth; i++)
            if (th[i].state == WAIT || th[i].state == FUTEX) {
                if (th[i].state == FUTEX) th[i].r[0] = (uint64_t) -4;
                th[i].state = RUN;
                break;
            }
}

/* the current thread, saved, gives way to the next runnable one */
static void reschedule(struct kb_cpu* cpu) {
    int k;
    wait_all(0);
    while ((k = pick()) < 0) wait_all(1);
    if (k != cur) kb_switches++;
    cur = k;
    load(cpu, &th[k]);
}

/** a time slice is up: the next runnable thread runs */
void kb_yield(struct kb_cpu* cpu) {
    ensure_main();
    save(cpu, &th[cur]);
    reschedule(cpu);
}

/** clone with CLONE_VM | CLONE_THREAD | CLONE_SIGHAND: a thread that starts
 * after the call on its own stack with 0; the caller gets its tid */
int64_t kb_thread_clone(struct kb_cpu* cpu, const uint64_t* a) {
    int x86 = cpu->arch == KB_X86;
    uint64_t f = a[0], ctid = x86 ? a[3] : a[4], tls = x86 ? a[4] : a[3];
    if ((f & 0x10900) != 0x10900) return -22;
    ensure_main();
    int k = 0;
    while (k < nth && th[k].state != DEAD) k++;
    if (k == nth) {
        if ((nth & (nth - 1)) == 0 && nth >= 8)
            th = realloc(th, 2 * (size_t) nth * sizeof *th);
        nth++;
    }
    struct kb_thread* t = &th[k];
    free(t->fds);
    memset(t, 0, sizeof *t);
    save(cpu, t);
    t->r[0] = 0;
    t->r[x86 ? 4 : 31] = a[1];
    if (f & 0x80000) { /* CLONE_SETTLS */
        if (x86)
            t->fs = tls;
        else
            t->tpidr = tls;
    }
    /* ponytail: tids from a range of their own, 64 per pid before they wrap */
    t->tid =
        0x40000000 + (((int64_t) getpid() * 64 + ++tids % 64) & 0x3fffffff);
    t->clear_tid = (f & 0x200000) ? ctid : 0;
    t->deadline = -1;
    t->state = RUN;
    if (f & 0x100000) kb_store(cpu, a[2], (uint64_t) t->tid, 4);
    if (f & 0x1000000) kb_store(cpu, ctid, (uint64_t) t->tid, 4);
    kb_nthreads++;
    return t->tid;
}

/* up to n FUTEX threads on word whose bitsets meet mask go on, returning 0 */
static int wake(uint64_t word, uint32_t n, uint32_t mask) {
    int woke = 0;
    for (int i = 0; i < nth && (uint32_t) woke < n; i++)
        if (th[i].state == FUTEX && th[i].word == word &&
            (th[i].bitset & mask)) {
            th[i].state = RUN;
            th[i].r[0] = 0;
            woke++;
        }
    return woke;
}

/** exit of one thread while others go on: 1 when another thread now runs */
int kb_thread_exit(struct kb_cpu* cpu) {
    if (kb_nthreads < 2) return 0;
    struct kb_thread* t = &th[cur];
    if (t->clear_tid) {
        kb_store(cpu, t->clear_tid, 0, 4);
        wake(t->clear_tid, 1, ~0u);
    }
    t->state = DEAD;
    kb_nthreads--;
    reschedule(cpu);
    return 1;
}

/* the current thread parks: r0 is what it returns when it goes on */
static int64_t park(struct kb_cpu* cpu, int state, int64_t r0) {
    ensure_main();
    save(cpu, &th[cur]);
    th[cur].state = state;
    th[cur].r[0] = (uint64_t) r0;
    reschedule(cpu);
    return KB_SWITCHED;
}

static int64_t ts_ns(struct kb_cpu* cpu, uint64_t at) {
    return (int64_t) kb_load(cpu, at, 8) * 1000000000 +
           (int64_t) kb_load(cpu, at + 8, 8);
}

/** futex: wait, wake, requeue and wake-op on guest words, all in this process
 */
int64_t kb_futex(struct kb_cpu* cpu, const uint64_t* a) {
    uint64_t word = a[0], word2 = a[4];
    int op = (int) (a[1] & 127);
    uint32_t val = (uint32_t) a[2], val3 = (uint32_t) a[5];
    if (!kb_host(cpu, word, 4)) return -14;
    switch (op) {
        case 0: /* wait, a relative timeout */
        case 9: /* wait_bitset, an absolute one */
        {
            if ((uint32_t) kb_load(cpu, word, 4) != val) return -11;
            uint32_t mask = op == 9 ? val3 : ~0u;
            if (!mask) return -22;
            int64_t deadline = -1;
            if (a[3]) {
                deadline = ts_ns(cpu, a[3]);
                if (op == 0)
                    deadline += now_ns();
                else if (a[1] & 256) { /* FUTEX_CLOCK_REALTIME */
                    struct timespec rt;
                    clock_gettime(CLOCK_REALTIME, &rt);
                    deadline += now_ns() -
                                ((int64_t) rt.tv_sec * 1000000000 + rt.tv_nsec);
                }
            }
            if (kb_nthreads < 2) {
                /* nobody else can wake it: the deadline, or a signal */
                while (!*kb_pending_flag) {
                    int64_t left =
                        deadline < 0 ? 10000000 : deadline - now_ns();
                    if (left <= 0) return -110;
                    struct timespec s = {0, left < 10000000 ? left : 10000000};
                    nanosleep(&s, NULL);
                }
                return -4;
            }
            ensure_main();
            th[cur].word = word;
            th[cur].bitset = mask;
            th[cur].deadline = deadline;
            return park(cpu, FUTEX, -110);
        }
        case 1: /* wake */
        case 10: return nth ? wake(word, val, op == 10 ? val3 : ~0u) : 0;
        case 3: /* requeue */
        case 4: /* cmp_requeue */
        {
            if (op == 4 && (uint32_t) kb_load(cpu, word, 4) != val3) return -11;
            int n = nth ? wake(word, val, ~0u) : 0;
            uint32_t moved = 0;
            for (int i = 0; i < nth && moved < (uint32_t) a[3]; i++)
                if (th[i].state == FUTEX && th[i].word == word) {
                    th[i].word = word2;
                    moved++;
                }
            return n + (int64_t) moved;
        }
        case 5: /* wake_op */
        {
            if (!kb_host(cpu, word2, 4)) return -14;
            int kind = (int) (val3 >> 28) & 7, cmp = (int) (val3 >> 24) & 15;
            int32_t oparg = (int32_t) (val3 << 8) >> 20,
                    cmparg = (int32_t) (val3 << 20) >> 20;
            if (val3 >> 31) oparg = 1 << (oparg & 31);
            int32_t old = (int32_t) kb_load(cpu, word2, 4), now = old;
            switch (kind) {
                case 0: now = oparg; break;
                case 1: now = old + oparg; break;
                case 2: now = old | oparg; break;
                case 3: now = old & ~oparg; break;
                case 4: now = old ^ oparg; break;
                default: return -38;
            }
            kb_store(cpu, word2, (uint32_t) now, 4);
            int n = nth ? wake(word, val, ~0u) : 0;
            int hit = cmp == 0   ? old == cmparg
                      : cmp == 1 ? old != cmparg
                      : cmp == 2 ? old < cmparg
                      : cmp == 3 ? old <= cmparg
                      : cmp == 4 ? old > cmparg
                                 : old >= cmparg;
            if (hit && nth) n += wake(word2, (uint32_t) a[3], ~0u);
            return n;
        }
    }
    return -38;
}

/* the guest's pollfd array as host pollfds (the event bits are the same) */
static struct pollfd* guest_pollfds(
    struct kb_cpu* cpu, uint64_t at, uint64_t n
) {
    struct pollfd* p = calloc(n ? n : 1, sizeof *p);
    for (uint64_t i = 0; i < n; i++) {
        p[i].fd = (int) kb_load(cpu, at + 8 * i, 4);
        p[i].events = (short) (kb_load(cpu, at + 8 * i + 4, 2) & 0x3f);
    }
    return p;
}

/* select's three sets as pollfds */
static struct pollfd* set_pollfds(
    struct kb_cpu* cpu, uint64_t n, const uint64_t* sets, int* count
) {
    struct pollfd* p = calloc(n ? n : 1, sizeof *p);
    int k = 0;
    for (uint64_t fd = 0; fd < n && fd < FD_SETSIZE; fd++) {
        short ev = 0;
        for (int s = 0; s < 3; s++)
            if (sets[s] &&
                (kb_load(cpu, sets[s] + 8 * (fd / 64), 8) >> (fd % 64) & 1))
                ev |= s == 0 ? POLLIN : s == 1 ? POLLOUT : POLLPRI;
        if (ev) p[k++] = (struct pollfd){(int) fd, ev, 0};
    }
    *count = k;
    return p;
}

/**
 * before a call that may block while other threads exist: 0 to run it (it will
 * not block), 1 when *v is its result already (its deadline passed), or 2
 * when the thread parked and the call reruns once it may go on
 */
int kb_thread_gate(
    struct kb_cpu* cpu, int64_t nr, const uint64_t* a, int64_t* v
) {
    struct pollfd* fds = NULL;
    int n = 0, sleep = 0;
    int64_t tmo = -1; /* ns; -1 waits for ever */
    switch (nr) {
        case 63: /* read readv recvfrom recvmsg accept accept4 */
        case 65:
        case 207:
        case 212:
        case 202:
        case 242:
            fds = calloc(1, sizeof *fds);
            *fds = (struct pollfd){(int) a[0], POLLIN, 0};
            n = 1;
            break;
        case -7: /* poll(fds, n, ms) */
            if ((int) a[2] >= 0) tmo = (int64_t) (int) a[2] * 1000000;
            fds = guest_pollfds(cpu, a[0], a[1]);
            n = (int) a[1];
            break;
        case 73: /* ppoll(fds, n, timespec, mask) */
            if (a[2]) tmo = ts_ns(cpu, a[2]);
            fds = guest_pollfds(cpu, a[0], a[1]);
            n = (int) a[1];
            break;
        case -8: /* select(n, r, w, e, timeval) */
        case 72: /* pselect6(n, r, w, e, timespec, mask) */
            if (a[4])
                tmo = nr == 72 ? ts_ns(cpu, a[4])
                               : (int64_t) kb_load(cpu, a[4], 8) * 1000000000 +
                                     (int64_t) kb_load(cpu, a[4] + 8, 8) * 1000;
            fds = set_pollfds(cpu, a[0], a + 1, &n);
            break;
        case 101: /* nanosleep(req, rem) */
            tmo = ts_ns(cpu, a[0]);
            sleep = 1;
            break;
        case 115: /* clock_nanosleep(clock, flags, req, rem) */
            tmo = ts_ns(cpu, a[2]);
            if (a[1] & 1) { /* TIMER_ABSTIME, on the named clock */
                struct timespec t;
                clock_gettime(a[0] == 0 ? CLOCK_REALTIME : CLOCK_MONOTONIC, &t);
                tmo -= (int64_t) t.tv_sec * 1000000000 + t.tv_nsec;
            }
            sleep = 1;
            break;
        case 260: /* wait4 without WNOHANG: looked at every 5 ms */
        {
            if (a[2] & WNOHANG) return 0;
            int st = 0;
            pid_t p = waitpid(
                (pid_t) (int64_t) a[0], &st, WNOHANG | ((int) a[2] & WUNTRACED)
            );
            if (p != 0) {
                if (p > 0 && a[1])
                    kb_store(cpu, a[1], (uint64_t) (uint32_t) st, 4);
                *v = p > 0 ? p : -(int64_t) errno;
                return 1;
            }
            tmo = 5000000;
            sleep = 2;
            break;
        }
        default: return 0;
    }
    ensure_main();
    struct kb_thread* t = &th[cur];
    uint64_t at = cpu->pc - (cpu->arch == KB_X86 ? 2 : 4);
    int ready = !sleep && poll(fds, (nfds_t) n, 0) > 0;
    int64_t now = now_ns();
    if (t->gate_pc != at) {
        t->gate_pc = at;
        t->gate_deadline = tmo < 0 ? -1 : now + tmo;
    }
    if (ready || tmo == 0 || (!sleep && n == 0 && tmo < 0)) {
        free(fds);
        t->gate_pc = 0;
        return 0;
    }
    if (t->gate_deadline >= 0 && now >= t->gate_deadline && sleep != 2) {
        /* timed out: poll's events and select's sets come back empty */
        if (nr == -7 || nr == 73)
            for (int i = 0; i < n; i++)
                kb_store(cpu, a[0] + 8 * (uint64_t) i + 6, 0, 2);
        if (nr == -8 || nr == 72)
            for (int s = 1; s <= 3; s++)
                for (uint64_t w = 0; a[s] && w < (a[0] + 63) / 64; w++)
                    kb_store(cpu, a[s] + 8 * w, 0, 8);
        free(fds);
        t->gate_pc = 0;
        *v = 0;
        return 1;
    }
    free(t->fds);
    t->fds = fds;
    t->nfds = n;
    t->deadline = t->gate_deadline;
    if (sleep == 2) t->deadline = now + tmo;
    cpu->pc = at;
    park(cpu, WAIT, (int64_t) cpu->r[0]);
    return 2;
}
