#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/mman.h>
#include <sys/shm.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static int attach_as_child(int id) {
    char* p = shmat(id, 0, 0);
    if (p == (char*) -1) return 2;
    struct shmid_ds ds;
    int ok = !strcmp(p, "parent") && shmctl(id, IPC_STAT, &ds) == 0 &&
             ds.shm_nattch == 2;
    if (!ok) printf("child sees \"%.8s\" at %p\n", p, p);
    strcpy(p, "child");
    shmdt(p);
    return ok ? 0 : 3;
}

/* runs this program again as argv[1..]; the exit status, or 128 + the signal
 * that ended it */
static int run(char* const* args) {
    int st = -1;
    pid_t pid = vfork();
    if (pid == 0) {
        execv("/bin/isolation", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    return WIFSIGNALED(st) ? 128 + WTERMSIG(st) : WEXITSTATUS(st);
}

static char own[64];

/* as uid 1000 in a child: attaches the segment, then stores and loads in it */
static int attach_and_touch(int id) {
    volatile char* p = shmat(id, 0, 0);
    if (p == (char*) -1) return 2;
    p[1] = 'y';
    int ok = p[1] == 'y';
    shmdt((char*) p);
    return ok ? 0 : 3;
}

static volatile int go, revoked;
static volatile char* page;
static int by_shmdt;

static void* revoker(void* arg) {
    (void) arg;
    while (!go) sched_yield();
    if (by_shmdt)
        shmdt((char*) page);
    else
        munmap((void*) page, 4096);
    revoked = 1;
    return 0;
}

/* as uid 1000: reads a page, then a sibling thread unmaps or detaches it while
 * this thread is parked (at a fuel yield, or in sched_yield with "syscall");
 * the same load after that must fault, however the check remembered the page */
static int read_revoked(const char* how) {
    by_shmdt = !strcmp(how, "shmdt");
    if (by_shmdt) {
        int id = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600);
        page = id >= 0 ? shmat(id, 0, 0) : (char*) -1;
        if (id >= 0) shmctl(id, IPC_RMID, 0);
    }
    else {
        page = mmap(
            0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        );
    }
    if (page == (char*) -1 || page == MAP_FAILED) return 2;
    page[0] = 1;
    pthread_t t;
    if (pthread_create(&t, 0, revoker, 0)) return 2;
    int yielding = !strcmp(how, "syscall"), seen = 0;
    long sum = 0;
    for (long i = 0; i < 400000000; i++) {
        if (revoked) seen++;
        sum += page[0];
        if (seen > 1) return 3;
        go = 1;
        if (yielding) sched_yield();
    }
    return sum ? 4 : 5;
}

/* as uid 1000: the kernel's memory, another process's and a segment it never
 * attached refused, to syscalls, loads and stores; a segment it attaches is
 * open (SECURITY.md) */
static int nonroot(char* other, char* shared, char* open_id) {
    void* kernel = (void*) 0x10000;
    void* theirs = (void*) strtoul(other, 0, 0);
    int fds[2];
    pipe(fds);
    CHECK(
        "nonroot syscall reading kernel memory refused",
        write(fds[1], kernel, 16) < 0 && errno == EFAULT
    );
    write(fds[1], "0123456789abcdef0123456789abcdef", 32);
    CHECK(
        "nonroot syscall writing kernel memory refused",
        read(fds[0], kernel, 16) < 0 && errno == EFAULT
    );
    CHECK(
        "nonroot syscall writing another process refused",
        read(fds[0], theirs, 16) < 0 && errno == EFAULT
    );
    CHECK(
        "nonroot syscall on its own memory",
        read(fds[0], own, 32) == 32 && !memcmp(own, "0123456789abcdef", 16)
    );
    char* kernel_poke[] = {"isolation", "poke", "0x10000", NULL};
    char* their_poke[] = {"isolation", "poke", other, NULL};
    char* own_poke[] = {"isolation", "poke", "own", NULL};
    CHECK(
        "nonroot store to kernel memory ends it with SIGSEGV",
        run(kernel_poke) == 128 + SIGSEGV
    );
    CHECK(
        "nonroot store to another process ends it with SIGSEGV",
        run(their_poke) == 128 + SIGSEGV
    );
    CHECK("nonroot store to its own memory", run(own_poke) == 0);
    char* kernel_peek[] = {"isolation", "peek", "0x10000", NULL};
    char* their_peek[] = {"isolation", "peek", other, NULL};
    char* own_peek[] = {"isolation", "peek", "own", NULL};
    CHECK(
        "nonroot load from kernel memory ends it with SIGSEGV",
        run(kernel_peek) == 128 + SIGSEGV
    );
    CHECK(
        "nonroot load from another process ends it with SIGSEGV",
        run(their_peek) == 128 + SIGSEGV
    );
    CHECK("nonroot load from its own memory", run(own_peek) == 0);
    char* shared_poke[] = {"isolation", "poke", shared, NULL};
    char* shared_peek[] = {"isolation", "peek", shared, NULL};
    CHECK(
        "nonroot store to a segment it never attached ends it with SIGSEGV",
        run(shared_poke) == 128 + SIGSEGV
    );
    CHECK(
        "nonroot load from a segment it never attached ends it with SIGSEGV",
        run(shared_peek) == 128 + SIGSEGV
    );
    char* attach[] = {"isolation", "attach", open_id, NULL};
    CHECK("nonroot store and load in a segment it attached", run(attach) == 0);
    char* unmapped[] = {"isolation", "revoke", "munmap", NULL};
    char* unmapped_syscall[] = {"isolation", "revoke", "syscall", NULL};
    char* detached[] = {"isolation", "revoke", "shmdt", NULL};
    CHECK(
        "nonroot load after a sibling unmaps the page ends it with SIGSEGV",
        run(unmapped) == 128 + SIGSEGV
    );
    CHECK(
        "nonroot load after a sibling unmaps the page during a syscall ends it "
        "with SIGSEGV",
        run(unmapped_syscall) == 128 + SIGSEGV
    );
    CHECK(
        "nonroot load after a sibling detaches the segment ends it with "
        "SIGSEGV",
        run(detached) == 128 + SIGSEGV
    );
    /* nommu has no MAP_FIXED, so a page reaches another owner only through an
     * unmap, which the checks above cover */
    void* mine = mmap(
        0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    void* fixed = mmap(
        mine, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0
    );
    CHECK("MAP_FIXED refused", fixed == MAP_FAILED && errno == EINVAL);
    return 0;
}

int main(int argc, char** argv) {
    if (argc == 3 && !strcmp(argv[1], "child"))
        return attach_as_child(atoi(argv[2]));
    if (argc == 5 && !strcmp(argv[1], "nonroot"))
        return nonroot(argv[2], argv[3], argv[4]);
    if (argc == 3 && !strcmp(argv[1], "attach"))
        return attach_and_touch(atoi(argv[2]));
    if (argc == 3 && !strcmp(argv[1], "revoke")) return read_revoked(argv[2]);
    if (argc == 3 && (!strcmp(argv[1], "poke") || !strcmp(argv[1], "peek"))) {
        volatile char* at =
            !strcmp(argv[2], "own") ? own : (char*) strtoul(argv[2], 0, 0);
        if (argv[1][1] == 'o')
            *at = 'x';
        else
            (void) *at;
        return 0;
    }

    /* below the program image: kernel memory on gmux, unmapped on native Linux
     */
    int fds[2];
    char copy[16];
    pipe(fds);
    long r = write(fds[1], (void*) 0x10000, sizeof copy);
    if (r == sizeof copy) read(fds[0], copy, sizeof copy);
    printf(
        "TRUST kernel-address write %s\n",
        r == sizeof copy && !memcmp(copy, (void*) 0x10000, sizeof copy)
            ? "accepted"
        : r < 0 && errno == EFAULT ? "refused"
                                   : "other"
    );

    /* the order PostgreSQL's interlock uses: exclusive create, attach, nattch
     */
    key_t key = 0x676d7578;
    int id = shmget(key, 4096, IPC_CREAT | IPC_EXCL | 0600);
    CHECK(
        "shmget exclusive",
        id >= 0 && shmget(key, 4096, IPC_CREAT | IPC_EXCL | 0600) < 0 &&
            errno == EEXIST
    );
    char* p = id >= 0 ? shmat(id, 0, 0) : (char*) -1;
    CHECK("shmat", p != (char*) -1);
    if (p == (char*) -1) return 1;
    strcpy(p, "parent");

    char ids[16];
    snprintf(ids, sizeof ids, "%d", id);
    int st = -1;
    pid_t pid = vfork();
    if (pid == 0) {
        char* args[] = {argv[0], "child", ids, NULL};
        execv("/bin/isolation", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    int shared = WIFEXITED(st) && WEXITSTATUS(st) == 0 && !strcmp(p, "child");
    CHECK("shm between processes", shared);
    if (!shared)
        printf(
            "child status %d, segment \"%.8s\"\n",
            WIFEXITED(st) ? WEXITSTATUS(st) : -1, p
        );

    struct shmid_ds ds;
    int stat = shmctl(id, IPC_STAT, &ds);
    CHECK("shm_nattch after child detach", stat == 0 && ds.shm_nattch == 1);
    if (stat) printf("IPC_STAT errno %d\n", errno);
    CHECK(
        "shmdt",
        shmdt(p) == 0 && shmctl(id, IPC_STAT, &ds) == 0 && ds.shm_nattch == 0
    );
    CHECK(
        "IPC_RMID",
        shmctl(id, IPC_RMID, 0) == 0 && shmget(key, 0, 0) < 0 && errno == ENOENT
    );

    /* the same program as uid 1000, handed the address of this (root) process's
     * memory */
    static char mine[64] = "root's";
    char addr[32], seg_addr[32];
    snprintf(addr, sizeof addr, "%p", (void*) mine);
    /* a segment only root attached, mode 0600 */
    int seg_id = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600);
    char* seg = seg_id >= 0 ? shmat(seg_id, 0, 0) : (char*) -1;
    CHECK("root-only segment", seg != (char*) -1);
    if (seg == (char*) -1) return 1;
    snprintf(seg_addr, sizeof seg_addr, "%p", (void*) seg);
    /* a segment anyone may attach, which the nonroot process attaches itself */
    int open_seg = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666);
    CHECK("open segment", open_seg >= 0);
    char open_id[16];
    snprintf(open_id, sizeof open_id, "%d", open_seg);
    pid = vfork();
    if (pid == 0) {
        char* args[] = {"isolation", "nonroot", addr, seg_addr, open_id, NULL};
        if (setuid(1000) == 0) execv("/bin/isolation", args);
        dprintf(2, "nonroot: %s\n", strerror(errno));
        _exit(127);
    }
    waitpid(pid, &st, 0);
    CHECK(
        "nonroot run",
        WIFEXITED(st) && WEXITSTATUS(st) == 0 && !strcmp(mine, "root's")
    );
    if (!WIFEXITED(st) || WEXITSTATUS(st))
        printf(
            "nonroot status %d signal %d\n",
            WIFEXITED(st) ? WEXITSTATUS(st) : -1,
            WIFSIGNALED(st) ? WTERMSIG(st) : 0
        );
    CHECK("root's segment untouched by the nonroot store", *seg != 'x');
    shmdt(seg);
    shmctl(seg_id, IPC_RMID, 0);
    shmctl(open_seg, IPC_RMID, 0);
    return 0;
}
