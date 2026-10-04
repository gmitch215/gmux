// the kernel's generation counters (patch 0030): after each call of a scripted
// sequence, a hash of the state each counter guards is compared with the
// counter, read from /proc/gmux_gens. State that changed while its counter did
// not is a missing bump (FAIL); a counter that moved over unchanged state is a
// false bump, which only costs a miss, and is counted. The lines are
// STEP <task><n> <call> fd:<hg> cred:<hg> mm:<hg> sig:<hg>, h for a changed
// hash and g for a moved counter; tests/c/run.ts tallies them. Built with
// resumable frames, as fork needs; `gens exec ...` is the image a child execs
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/eventfd.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

enum
{
    FD,
    CRED,
    MM,
    SIG,
    CLASSES
};
static const char* const cname[CLASSES] = {"fd", "cred", "mm", "sig"};

typedef struct {
    uint64_t gen[CLASSES], hash[CLASSES];
    char tag;
    int n;
} Snap;

static int gens_fd = -1, maps_fd = -1;
static int bumps[CLASSES], falses[CLASSES], missed[CLASSES], steps;
static volatile int handled;
static char maps_text[32768];

#define CAP_V3 0x20080522
struct cap_head {
    uint32_t version;
    int pid;
};
struct cap_data {
    uint32_t effective, permitted, inheritable;
};

static void say(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void say(const char* fmt, ...) {
    char line[256];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);
    if (n > (int) sizeof line - 1) n = sizeof line - 1;
    write(1, line, n);
}

static uint64_t mix(uint64_t h, uint64_t v) {
    for (int i = 0; i < 8; i++)
        h = (h ^ ((v >> (8 * i)) & 0xff)) * 1099511628211ull;
    return h;
}

static const uint64_t seed = 14695981039346656037ull;

static int read_gens(uint64_t gen[CLASSES], unsigned long* block) {
    char text[160];
    ssize_t n = pread(gens_fd, text, sizeof text - 1, 0);
    if (n <= 0) return -1;
    text[n] = 0;
    char* p;
    *block = strtoul(text, &p, 16);
    for (int i = 0; i < CLASSES; i++) gen[i] = strtoull(p, &p, 10);
    return 0;
}

// the fd table: which descriptors are open, close-on-exec, and what they name
static uint64_t hash_fd(void) {
    uint64_t h = seed;
    for (int fd = 0; fd < 256; fd++) {
        int flags = fcntl(fd, F_GETFD);
        struct stat st;
        if (flags < 0 || fstat(fd, &st)) continue;
        h = mix(h, fd);
        h = mix(h, flags);
        h = mix(h, st.st_dev);
        h = mix(h, st.st_ino);
        h = mix(h, st.st_mode);
    }
    return h;
}

static uint64_t hash_cred(void) {
    uint64_t h = seed;
    uid_t r, e, s;
    gid_t gr, ge, gs, groups[64];
    syscall(SYS_getresuid, &r, &e, &s);
    syscall(SYS_getresgid, &gr, &ge, &gs);
    h = mix(mix(mix(h, r), e), s);
    h = mix(mix(mix(h, gr), ge), gs);
    int n = getgroups(64, groups);
    h = mix(h, n);
    for (int i = 0; i < n; i++) h = mix(h, groups[i]);
    struct cap_head head = {CAP_V3, 0};
    struct cap_data data[2] = {{0, 0, 0}, {0, 0, 0}};
    syscall(SYS_capget, &head, data);
    for (int i = 0; i < 2; i++) {
        h =
            mix(mix(mix(h, data[i].effective), data[i].permitted),
                data[i].inheritable);
    }
    h = mix(h, prctl(PR_GET_SECUREBITS));
    h = mix(h, prctl(PR_GET_KEEPCAPS));
    for (int cap = 0; cap <= 40; cap++) h = mix(h, prctl(PR_CAPBSET_READ, cap));
    // a read of the filesystem ids: an invalid id changes nothing and returns
    // the old one
    h = mix(h, syscall(SYS_setfsuid, -1));
    h = mix(h, syscall(SYS_setfsgid, -1));
    return h;
}

// the handler table; the blocked mask is the task's own and not part of it
static uint64_t hash_sig(void) {
    uint64_t h = seed;
    for (int sig = 1; sig < 65; sig++) {
        struct sigaction old;
        if (sig >= 32 && sig <= 34) continue;
        if (sigaction(sig, 0, &old)) continue;
        uint64_t mask;
        memcpy(&mask, &old.sa_mask, sizeof mask);
        h = mix(h, sig);
        h = mix(h, (uintptr_t) old.sa_handler);
        h = mix(h, old.sa_flags);
        h = mix(h, mask);
    }
    return h;
}

// the mappings, as the nommu /proc/self/maps lists them
static uint64_t hash_mm(void) {
    uint64_t h = seed;
    size_t len = 0;
    ssize_t n;
    // the file's position is an address, so it is read from the start with read
    lseek(maps_fd, 0, SEEK_SET);
    while (len < sizeof maps_text &&
           (n = read(maps_fd, maps_text + len, sizeof maps_text - len)) > 0)
        len += n;
    for (size_t i = 0; i < len; i++)
        h = (h ^ (unsigned char) maps_text[i]) * 1099511628211ull;
    return h;
}

static void snap(Snap* s) {
    unsigned long block;
    read_gens(s->gen, &block);
    s->hash[FD] = hash_fd();
    s->hash[CRED] = hash_cred();
    s->hash[MM] = hash_mm();
    s->hash[SIG] = hash_sig();
}

// compares the state and the counters with the last snapshot of this task
static int step(Snap* b, const char* name) {
    Snap n = *b;
    char line[200];
    int len, missing = 0, moved = 0;
    snap(&n);
    len = snprintf(line, sizeof line, "STEP %c%02d %s", b->tag, b->n++, name);
    for (int c = 0; c < CLASSES; c++) {
        int h = n.hash[c] != b->hash[c], g = n.gen[c] != b->gen[c];
        len += snprintf(
            line + len, sizeof line - len, " %s:%c%c", cname[c], h ? 'h' : '-',
            g ? 'g' : '-'
        );
        if (h && g) bumps[c]++;
        if (g && !h) falses[c]++;
        if (g) moved |= 1 << c;
        if (h && !g) {
            missed[c]++;
            missing++;
        }
    }
    line[len++] = '\n';
    write(1, line, len);
    if (missing) say("FAIL missing bump after %s\n", name);
    steps++;
    n.tag = b->tag;
    n.n = b->n;
    *b = n;
    return moved;
}

static int misses(void) {
    return missed[FD] + missed[CRED] + missed[MM] + missed[SIG];
}

// a counter that moves over what another task did costs a miss and nothing else
static void unmoved(Snap* b, const char* name, int quiet, const char* what) {
    int moved = step(b, name);
    if (moved & quiet)
        say("NOTE %s: counter mask %d moved (%s)\n", name, moved & quiet, what);
}

#define STEP(name, ...)                                                        \
    do {                                                                       \
        (void) (__VA_ARGS__);                                                  \
        step(&m, name);                                                        \
    } while (0)

static void on(int sig) {
    handled++;
}

static int fa = -1, fb = -1;

static void fd_class(Snap* m_) {
    Snap m = *m_;
    char buf[16];
    int pa[2], pb[2], sp[2];
    STEP("open", fa = open("/init", O_RDONLY));
    STEP("open_cloexec", fb = open("/init", O_RDONLY | O_CLOEXEC));
    STEP("open_missing", open("/nonexistent/x", O_RDONLY));
    STEP("dup", dup(fa));
    STEP("dup2", dup2(fa, 20));
    STEP("dup2_same", dup2(fa, fa));
    STEP("dup3_cloexec", dup3(fa, 21, O_CLOEXEC));
    STEP("setfd_cloexec", fcntl(fa, F_SETFD, FD_CLOEXEC));
    STEP("setfd_clear", fcntl(fa, F_SETFD, 0));
    STEP("dupfd", fcntl(fa, F_DUPFD, 30));
    STEP("dupfd_cloexec", fcntl(fa, F_DUPFD_CLOEXEC, 40));
    STEP("getfd", fcntl(fa, F_GETFD));
    STEP("setfl", fcntl(fa, F_SETFL, O_NONBLOCK));
    STEP("read", read(fa, buf, sizeof buf));
    STEP("lseek", lseek(fa, 0, SEEK_SET));
    STEP("pipe", pipe(pa));
    STEP("pipe2_cloexec", pipe2(pb, O_CLOEXEC));
    STEP("socketpair", socketpair(AF_UNIX, SOCK_STREAM, 0, sp));
    STEP("eventfd", eventfd(0, 0));
    STEP("memfd", memfd_create("gens", 0));
    STEP("close", close(fa));
    STEP("close_badf", close(200));
    STEP("close_range_cloexec", syscall(SYS_close_range, 30, 31, 4));
    STEP("close_range", syscall(SYS_close_range, 40, 100, 0));
    *m_ = m;
}

static void cred_class(Snap* m_) {
    Snap m = *m_;
    gid_t groups[2] = {5, 6};
    struct cap_head head = {CAP_V3, 0};
    struct cap_data was[2] = {{0, 0, 0}, {0, 0, 0}}, now[2];
    STEP("setuid_same", syscall(SYS_setuid, 0));
    STEP("setresuid_euid", syscall(SYS_setresuid, -1, 1000, -1));
    STEP("setresuid_restore", syscall(SYS_setresuid, -1, 0, -1));
    STEP("setgroups", syscall(SYS_setgroups, 2, groups));
    STEP("setresgid", syscall(SYS_setresgid, -1, 100, -1));
    STEP("setresgid_restore", syscall(SYS_setresgid, -1, 0, -1));
    STEP("setfsuid", syscall(SYS_setfsuid, 1000));
    STEP("setfsuid_restore", syscall(SYS_setfsuid, 0));
    STEP("keepcaps", prctl(PR_SET_KEEPCAPS, 1));
    STEP("keepcaps_clear", prctl(PR_SET_KEEPCAPS, 0));
    STEP("capbset_drop", prctl(PR_CAPBSET_DROP, 25));
    syscall(SYS_capget, &head, was);
    memcpy(now, was, sizeof now);
    now[0].effective &= ~(1u << 10);
    STEP("capset_drop", syscall(SYS_capset, &head, now));
    STEP("capset_restore", syscall(SYS_capset, &head, was));
    STEP("securebits", prctl(PR_SET_SECUREBITS, 4));
    STEP("securebits_clear", prctl(PR_SET_SECUREBITS, 0));
    *m_ = m;
}

static void sig_class(Snap* m_) {
    Snap m = *m_;
    struct sigaction handler = {.sa_handler = on},
                     ign = {.sa_handler = SIG_IGN},
                     dfl = {.sa_handler = SIG_DFL},
                     once = {.sa_handler = on, .sa_flags = SA_RESETHAND}, old;
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    STEP("sigaction", sigaction(SIGUSR1, &handler, 0));
    STEP("sigaction_same", sigaction(SIGUSR1, &handler, 0));
    STEP("sigaction_ign", sigaction(SIGUSR1, &ign, 0));
    STEP("sigaction_dfl", sigaction(SIGUSR1, &dfl, 0));
    STEP("sigaction_get", sigaction(SIGUSR1, 0, &old));
    STEP("sigaction_once", sigaction(SIGUSR2, &once, 0));
    STEP("raise_once", raise(SIGUSR2));
    STEP("sigprocmask_block", sigprocmask(SIG_BLOCK, &set, 0));
    STEP("sigprocmask_unblock", sigprocmask(SIG_UNBLOCK, &set, 0));
    *m_ = m;
}

static void mm_class(Snap* m_) {
    Snap m = *m_;
    char *p = 0, *q = 0, *r = 0;
    long cur = 0;
    int f = -1;
    STEP(
        "mmap",
        p = mmap(
            0, 65536, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        )
    );
    STEP(
        "mmap_second",
        q = mmap(
            0, 16384, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        )
    );
    STEP("munmap", munmap(q, 16384));
    STEP("munmap_head", munmap(p, 4096));
    STEP("munmap_tail", munmap(p + 65536 - 4096, 4096));
    STEP(
        "mmap_third",
        r = mmap(
            0, 16384, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        )
    );
    STEP("mremap_shrink", mremap(r, 16384, 8192, 0));
    // grown back before it is unmapped: nommu leaves the mapping tree at the
    // old size after a shrink
    STEP("mremap_grow", mremap(r, 8192, 16384, 0));
    STEP("mprotect", mprotect(r, 4096, PROT_READ));
    STEP("brk_get", cur = syscall(SYS_brk, 0));
    STEP("brk_grow", syscall(SYS_brk, cur + 4096));
    STEP("madvise_dontneed", madvise(p + 4096, 4096, MADV_DONTNEED));
    STEP("open_for_map", f = open("/init", O_RDONLY));
    STEP("mmap_file", q = mmap(0, 4096, PROT_READ, MAP_PRIVATE, f, 0));
    STEP("munmap_file", munmap(q, 4096));
    STEP("close_for_map", close(f));
    STEP(
        "mmap_shared",
        q = mmap(
            0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0
        )
    );
    STEP("munmap_shared", munmap(q, 4096));
    STEP("munmap_rest", munmap(p + 4096, 65536 - 8192));
    STEP("munmap_third", munmap(r, 16384));
    *m_ = m;
}

// a thread shares the fd table, memory and handlers of its process and has
// credentials of its own
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static void (*job)(Snap*);
static int working, stop;
static int shared_fd = -1;

static void* worker(void* arg) {
    Snap t = {.tag = 't'};
    pthread_mutex_lock(&mu);
    for (;;) {
        while (!job && !stop) pthread_cond_wait(&cv, &mu);
        if (stop) break;
        void (*run)(Snap*) = job;
        job = 0;
        run(&t);
        working = 0;
        pthread_cond_broadcast(&cv);
    }
    pthread_mutex_unlock(&mu);
    return arg;
}

static void run_job(void (*fn)(Snap*)) {
    pthread_mutex_lock(&mu);
    job = fn;
    working = 1;
    pthread_cond_broadcast(&cv);
    while (working) pthread_cond_wait(&cv, &mu);
    pthread_mutex_unlock(&mu);
}

static void job_snap(Snap* t) {
    snap(t);
}

static void job_close(Snap* t) {
    close(shared_fd);
    step(t, "thread_close");
}

static void job_mmap(Snap* t) {
    mmap(0, 16384, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    step(t, "thread_mmap");
}

static void job_sigaction(Snap* t) {
    struct sigaction a = {.sa_handler = on};
    sigaction(SIGUSR1, &a, 0);
    step(t, "thread_sigaction");
}

static void job_cred(Snap* t) {
    syscall(SYS_setresuid, -1, 1000, -1);
    step(t, "thread_euid");
    syscall(SYS_setresuid, -1, 0, -1);
    step(t, "thread_euid_restore");
}

static void job_unshare(Snap* t) {
    unshare(CLONE_FILES);
    step(t, "thread_unshare");
    close(fb);
    step(t, "thread_close_unshared");
}

static void job_range_unshare(Snap* t) {
    syscall(SYS_close_range, 90, 99, 2);
    step(t, "thread_range_unshare");
    close(fb);
    step(t, "thread_close_range_unshared");
}

// returns the number of missing bumps this section found
static int thread_class(Snap* m_) {
    Snap m = *m_;
    int before = misses();
    pthread_t tid;
    STEP("pthread_create", pthread_create(&tid, 0, worker, 0));
    run_job(job_snap);
    STEP("open_shared_fd", shared_fd = open("/init", O_RDONLY));
    run_job(job_snap);
    run_job(job_close);
    // the thread closed it: this task's table changed and its counter is the
    // same one
    step(&m, "main_sees_close");
    run_job(job_mmap);
    step(&m, "main_sees_mmap");
    run_job(job_sigaction);
    step(&m, "main_sees_sigaction");
    run_job(job_cred);
    // credentials are the thread's own: this task's counter has no reason to
    // move
    unmoved(&m, "main_sees_euid", 1 << CRED, "credentials are per task");
    STEP("open_unshared_fd", fb = open("/init", O_RDONLY));
    run_job(job_snap);
    run_job(job_unshare);
    // the thread's table is its own now: closing in it changes nothing of this
    // task's
    unmoved(&m, "main_sees_unshare", 1 << FD, "an unshared table is private");
    pthread_mutex_lock(&mu);
    stop = 1;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
    STEP("pthread_join", pthread_join(tid, 0));
    // a second thread, so the table is shared again for close_range's own
    // unshare
    stop = 0;
    STEP("pthread_create_again", pthread_create(&tid, 0, worker, 0));
    STEP("open_range_fd", fb = open("/init", O_RDONLY));
    run_job(job_snap);
    run_job(job_range_unshare);
    unmoved(
        &m, "main_sees_range_unshare", 1 << FD,
        "close_range makes a private table"
    );
    pthread_mutex_lock(&mu);
    stop = 1;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
    STEP("pthread_join_again", pthread_join(tid, 0));
    *m_ = m;
    return misses() - before;
}

static int status_of(pid_t p) {
    int st = -1;
    waitpid(p, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st)
                         : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
}

// a fork child has copies of the tables and counters of its own
static int child_class(Snap* m_) {
    Snap m = *m_;
    pid_t child = fork();
    if (child == 0) {
        Snap k = {.tag = 'c'};
        struct sigaction a = {.sa_handler = on};
        char* q;
        int before = misses();
        // the inherited descriptor lists the parent's mappings
        close(maps_fd);
        maps_fd = open("/proc/self/maps", O_RDONLY);
        snap(&k);
        step(&k, "child_idle");
        step(&k, "child_idle_again");
        close(20);
        step(&k, "child_close");
        open("/init", O_RDONLY);
        step(&k, "child_open");
        q = mmap(
            0, 16384, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        );
        step(&k, "child_mmap");
        munmap(q, 16384);
        step(&k, "child_munmap");
        sigaction(SIGUSR1, &a, 0);
        step(&k, "child_sigaction");
        syscall(SYS_setresuid, -1, 1000, -1);
        step(&k, "child_euid");
        _exit(misses() != before);
    }
    int rc = child < 0 ? -1 : status_of(child);
    // the child's descriptors, credentials and handlers are not this task's
    // (its mappings are not either, but fork itself maps memory for the child's
    // frames into this task)
    unmoved(
        &m, "after_child", (1 << FD) | (1 << CRED) | (1 << SIG),
        "a fork child's tables are its own"
    );
    *m_ = m;
    return rc;
}

// the child sets what exec resets or closes, hands its snapshot to the new
// image through argv, and the image compares its own state with it
static int exec_class(void) {
    pid_t child = fork();
    if (child == 0) {
        Snap k = {.tag = 'x'};
        struct sigaction a = {.sa_handler = on}, ign = {.sa_handler = SIG_IGN};
        char arg[CLASSES * 2 + 2][20];
        char* argv[CLASSES * 2 + 5];
        sigaction(SIGUSR1, &a, 0);
        sigaction(SIGUSR2, &ign, 0);
        open("/init", O_RDONLY | O_CLOEXEC);
        snap(&k);
        argv[0] = "gens";
        argv[1] = "exec";
        snprintf(arg[0], sizeof arg[0], "%d", gens_fd);
        snprintf(arg[1], sizeof arg[1], "%d", maps_fd);
        for (int c = 0; c < CLASSES; c++) {
            snprintf(
                arg[2 + c], sizeof arg[0], "%llx", (unsigned long long) k.gen[c]
            );
            snprintf(
                arg[2 + CLASSES + c], sizeof arg[0], "%llx",
                (unsigned long long) k.hash[c]
            );
        }
        for (int i = 0; i < CLASSES * 2 + 2; i++) argv[2 + i] = arg[i];
        argv[CLASSES * 2 + 4] = 0;
        execv("/bin/gens", argv);
        _exit(127);
    }
    return child < 0 ? -1 : status_of(child);
}

// the new image: its fd, credential and handler state, then (after reopening
// the maps, which are the old image's) its memory, against what the child saw
// before exec
static int exec_image(char** argv) {
    Snap before = {.tag = 'e'}, now = {.tag = 'e'};
    unsigned long block;
    char line[200];
    int len, missing = 0, c;
    gens_fd = atoi(argv[2]);
    maps_fd = atoi(argv[3]);
    for (c = 0; c < CLASSES; c++) {
        before.gen[c] = strtoull(argv[4 + c], 0, 16);
        before.hash[c] = strtoull(argv[4 + CLASSES + c], 0, 16);
    }
    read_gens(now.gen, &block);
    now.hash[FD] = hash_fd();
    now.hash[CRED] = hash_cred();
    now.hash[SIG] = hash_sig();
    close(maps_fd);
    maps_fd = open("/proc/self/maps", O_RDONLY);
    now.hash[MM] = hash_mm();
    len = snprintf(line, sizeof line, "STEP e00 exec");
    for (c = 0; c < CLASSES; c++) {
        int h = now.hash[c] != before.hash[c], g = now.gen[c] != before.gen[c];
        len += snprintf(
            line + len, sizeof line - len, " %s:%c%c", cname[c], h ? 'h' : '-',
            g ? 'g' : '-'
        );
        if (h && !g && c != MM) missing++;
        if (c == MM && !g) missing++;
    }
    line[len++] = '\n';
    write(1, line, len);
    if (missing) say("FAIL missing bump after exec\n");
    return missing ? 1 : 0;
}

static int block_read(void) {
    uint64_t gen[CLASSES];
    unsigned long block;
    read_gens(gen, &block);
    uint64_t* const* b = (uint64_t* const*) block;
    for (int c = 0; c < CLASSES; c++)
        if (*(volatile uint64_t*) b[c] != gen[c]) return 0;
    return 1;
}

#define CHECK(name, ok) say("%s %s\n", (ok) ? "PASS" : "FAIL", name)

int main(int argc, char** argv) {
    Snap m = {.tag = 'm'};
    if (argc > 5 && !strcmp(argv[1], "exec")) return exec_image(argv);
    gens_fd = open("/proc/gmux_gens", O_RDONLY);
    maps_fd = open("/proc/self/maps", O_RDONLY);
    if (gens_fd < 0 || maps_fd < 0) {
        say("FAIL no /proc/gmux_gens\n");
        return 1;
    }
    snap(&m);
    int moved = step(&m, "idle");
    moved |= step(&m, "idle_again");
    CHECK("idle calls move no counter", !moved);
    fd_class(&m);
    cred_class(&m);
    sig_class(&m);
    mm_class(&m);
    int bad = thread_class(&m);
    CHECK("a thread's changes move the counters it shares", !bad);
    int rc = child_class(&m);
    CHECK("a fork child's changes are its own", rc == 0);
    rc = exec_class();
    CHECK("exec moves what it changes", rc == 0);
    CHECK("fd table: every change moved the counter", bumps[FD] && !missed[FD]);
    CHECK(
        "credentials: every change moved the counter",
        bumps[CRED] && !missed[CRED]
    );
    CHECK(
        "memory map: every change moved the counter", bumps[MM] && !missed[MM]
    );
    CHECK(
        "signal handlers: every change moved the counter",
        bumps[SIG] && !missed[SIG]
    );
    CHECK("the block's pointers read from user memory", block_read());
    say("SUMMARY steps %d bumps %d/%d/%d/%d false %d/%d/%d/%d\n", steps,
        bumps[FD], bumps[CRED], bumps[MM], bumps[SIG], falses[FD], falses[CRED],
        falses[MM], falses[SIG]);
    return 0;
}
