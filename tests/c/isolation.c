#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ipc.h>
#include <sys/mman.h>
#include <sys/shm.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
/* the second pass runs with kernel.gmux_own_exec 1 and prints "own: " before
 * each name */
static int own_mode(void) {
    return getenv("ISOLATION_OWN") != NULL;
}
#define TAG (own_mode() ? "own: " : "")
#define CHECK(name, ok) printf("%s %s%s\n", (ok) ? "PASS" : "FAIL", TAG, name)

/* 0: a non-root exec runs in the machine's memory under the guarded build; 1:
 * in a memory of its own */
static void own_exec(int on) {
    int fd = open("/proc/sys/kernel/gmux_own_exec", O_WRONLY);
    if (fd < 0 || write(fd, on ? "1" : "0", 1) != 1)
        printf("FAIL kernel.gmux_own_exec could not be set\n");
    if (fd >= 0) close(fd);
}

enum
{
    KIND_OWN = 20,
    KIND_SHARED = 21
};

/* the build this process runs, by what a load at a kernel address finds: the
 * guarded build ends it, the plain build in the shared memory reads the
 * kernel's bytes, a memory of its own reads zeros */
static int kind_code(const char* at) {
    volatile const unsigned char* p =
        (volatile const unsigned char*) strtoul(at, 0, 0);
    unsigned char sum = 0;
    for (int i = 0; i < 16; i++) sum |= p[i];
    return sum ? KIND_SHARED : KIND_OWN;
}

/* the bytes the own-memory stores write, xor 0x5a so the program's image does
 * not hold them; the host scans the machine's memory for GMUXOWNSTOREMARK after
 * the run */
static const unsigned char stored[16] = {0x1d, 0x17, 0x0f, 0x02, 0x15, 0x0d,
                                         0x14, 0x09, 0x0e, 0x15, 0x08, 0x1f,
                                         0x17, 0x1b, 0x08, 0x11};

/* as a process in a memory of its own: an address that is another owner's reads
 * zeros, and a store and the syscalls that name it reach only this process's
 * bytes */
static int reach(char* addr) {
    volatile unsigned char* p = (volatile unsigned char*) addr;
    volatile unsigned char key = 0x5a;
    unsigned char got[16];
    int fds[2], bad = 0, i;
    if (pipe(fds)) return 100;
    for (i = 0; i < 16; i++)
        if (p[i]) bad |= 1;
    if (write(fds[1], addr, 16) != 16 || read(fds[0], got, 16) != 16)
        bad |= 2;
    else
        for (i = 0; i < 16; i++)
            if (got[i]) bad |= 4;
    if (write(fds[1], "abcdefghijklmnop", 16) != 16 ||
        read(fds[0], addr, 16) != 16)
        bad |= 8;
    else if (memcmp(addr, "abcdefghijklmnop", 16))
        bad |= 16;
    for (i = 0; i < 16; i++) p[i] = stored[i] ^ key;
    for (i = 0; i < 16; i++)
        if (p[i] != (stored[i] ^ key)) bad |= 32;
    close(fds[0]);
    close(fds[1]);
    if (bad) printf("reach %p: %d\n", (void*) addr, bad);
    return bad;
}

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
        /* in a memory of its own the load has no page to lose; it reads this
         * process's bytes */
        if (seen && own_mode()) return 0;
        if (seen > 1) return 3;
        go = 1;
        if (yielding) sched_yield();
    }
    return sum ? 4 : 5;
}

/* a nonzero exit status, printed where a check that expected 0 can show it */
static int status(int got) {
    if (got) printf("exit status %d\n", got);
    return got;
}

static void check(const char* kind, const char* what, int ok) {
    printf("%s %s%s: %s\n", ok ? "PASS" : "FAIL", TAG, kind, what);
}

/* the shared objects, one kind each: a System V segment (arg: its id), a POSIX
 * shm object (its name), a file (its path) and anonymous shared memory */
static char* map_kind(const char* kind, const char* arg) {
    if (!strcmp(kind, "sysv")) return shmat(atoi(arg), 0, 0);
    int fd = -1, flags = MAP_SHARED;
    if (!strcmp(kind, "posix"))
        fd = shm_open(arg, O_RDWR, 0);
    else if (!strcmp(kind, "file"))
        fd = open(arg, O_RDWR);
    else
        flags |= MAP_ANONYMOUS;
    if (fd < 0 && !(flags & MAP_ANONYMOUS)) return MAP_FAILED;
    char* p = mmap(0, 4096, PROT_READ | PROT_WRITE, flags, fd, 0);
    if (fd >= 0) close(fd);
    return p;
}

static int unmap_kind(const char* kind, char* p) {
    return !strcmp(kind, "sysv") ? shmdt(p) : munmap(p, 4096);
}

/* as uid 1000: maps the object, then stores, loads and hands it to syscalls
 * both ways */
static int member(const char* kind, const char* arg) {
    volatile char* p = map_kind(kind, arg);
    int fds[2];
    if (p == (char*) -1 || pipe(fds)) return 2;
    p[64] = 'y';
    int ok = p[64] == 'y' && write(fds[1], (char*) p + 64, 4) == 4 &&
             read(fds[0], (char*) p + 72, 4) == 4 &&
             !memcmp((char*) p + 64, (char*) p + 72, 4);
    unmap_kind(kind, (char*) p);
    return ok ? 0 : 3;
}

/* as uid 1000, while root maps all of the file: maps its first half and then
 * its second half read-only, which share root's region; the first half keeps
 * its stores beside the second mapping and after it is unmapped */
static int halves(const char* path) {
    int fd = open(path, O_RDWR);
    if (fd < 0) return 2;
    volatile char* lo =
        mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    char* hi = mmap(0, 8192, PROT_READ, MAP_SHARED, fd, 8192);
    close(fd);
    if (lo == MAP_FAILED || hi == MAP_FAILED) return 2;
    lo[64] = 'a';
    if (munmap(hi, 8192)) return 2;
    lo[65] = 'b';
    int ok = lo[64] == 'a' && lo[65] == 'b';
    munmap((char*) lo, 8192);
    return ok ? 0 : 3;
}

/* as uid 1000, while root maps all of the file: maps its second and third
 * page and says so on `up`; once root has unmapped the rest (a byte on `down`)
 * unmaps them, maps an object of its own, which takes the region id they just
 * gave back, and stores to the first or last page of the old region */
static int stale(char** a) {
    char* whole = (char*) strtoul(a[3], 0, 0);
    int last = atoi(a[4]), up = atoi(a[5]), down = atoi(a[6]);
    int fd = open(a[1], O_RDWR);
    char* part =
        fd < 0 ? MAP_FAILED
               : mmap(0, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 4096);
    if (fd >= 0) close(fd);
    if (part != whole + 4096) return 2;
    char c = 'r';
    write(up, &c, 1);
    if (read(down, &c, 1) != 1 || munmap(part, 8192)) return 2;
    if (map_kind("file", a[2]) == MAP_FAILED) return 2;
    *(volatile char*) (whole + (last ? 12288 : 0)) = 'x';
    return 0;
}

/* as uid 1000 in a memory of its own: maps a page, says where on `up` and
 * unmaps it; once root has mapped pages of its own, one of which took the
 * address (a byte on `down`), the address holds none of root's bytes */
static int newowner(char** a) {
    int up = atoi(a[2]), down = atoi(a[3]);
    volatile char* page = mmap(
        0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    if (page == MAP_FAILED) return 2;
    page[0] = 1;
    char at[32], c;
    snprintf(at, sizeof at, "%p", (void*) page);
    write(up, at, sizeof at);
    if (munmap((void*) page, 4096) || read(down, &c, 1) != 1) return 2;
    for (int i = 0; i + 8 <= 4096; i++)
        if (!memcmp((char*) page + i, "NEWOWNER", 8)) return 3;
    return 0;
}

/* root maps pages with its marker until one lands where the uid 1000 process's
 * page was */
static int new_owner_check(void) {
    int up[2], down[2];
    if (pipe(up) || pipe(down)) return 0;
    char from[8], to[8];
    snprintf(from, sizeof from, "%d", up[1]);
    snprintf(to, sizeof to, "%d", down[0]);
    char* args[] = {"isolation", "newowner", from, to, NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        if (setuid(1000) == 0) execv("/bin/isolation", args);
        _exit(127);
    }
    char at[32] = "";
    int ready = read(up[0], at, sizeof at) == sizeof at;
    char* want = (char*) strtoul(at, 0, 0);
    char* maps[512];
    int n = 0, hit = 0;
    while (ready && n < 512 && !hit) {
        maps[n] = mmap(
            0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        );
        if (maps[n] == MAP_FAILED) break;
        memcpy(maps[n], "NEWOWNER", 8);
        hit = maps[n++] == want;
    }
    write(down[1], "g", 1);
    int st = -1;
    waitpid(pid, &st, 0);
    while (n) munmap(maps[--n], 4096);
    close(up[0]);
    close(up[1]);
    close(down[0]);
    close(down[1]);
    int ok = ready && hit && WIFEXITED(st) && !WEXITSTATUS(st);
    if (!ok)
        printf("ready %d, address taken %d, wait status %d\n", ready, hit, st);
    return ok;
}

/* as uid 1000: maps the object and detaches it, then touches it; a store or a
 * load must end the process, a syscall must be refused */
static int detached(const char* kind, const char* arg, const char* how) {
    volatile char* p = map_kind(kind, arg);
    int fds[2];
    if (p == (char*) -1 || pipe(fds)) return 2;
    p[64] = 'x';
    if (unmap_kind(kind, (char*) p)) return 2;
    if (own_mode()) {
        /* nothing faults: the address is this process's own bytes */
        char in[4];
        if (!strcmp(how, "sys"))
            return write(fds[1], (char*) p, 4) == 4 &&
                           read(fds[0], in, 4) == 4 &&
                           write(fds[1], "abcd", 4) == 4 &&
                           read(fds[0], (char*) p, 4) == 4
                       ? 0
                       : 3;
        if (!strcmp(how, "load"))
            (void) *p;
        else
            *p = 'z';
        return 0;
    }
    if (!strcmp(how, "sys")) {
        int out = write(fds[1], (char*) p, 4) < 0 && errno == EFAULT;
        write(fds[1], "abcd", 4);
        int in = read(fds[0], (char*) p, 4) < 0 && errno == EFAULT;
        return out && in ? 0 : 3;
    }
    if (!strcmp(how, "load"))
        (void) *p;
    else
        *p = 'z';
    return 4;
}

static void* stamper(void* p) {
    ((volatile char*) p)[67] = 't';
    return 0;
}

/* as uid 1000: a vfork child and a thread share the mapping; a program the
 * child execs is a non-member */
static int inherited(const char* kind, const char* arg, const char* how) {
    volatile char* p = map_kind(kind, arg);
    if (p == (char*) -1) return 2;
    int st = -1;
    if (!strcmp(how, "vfork")) {
        pid_t pid = vfork();
        if (pid == 0) {
            p[66] = 'v';
            _exit(0);
        }
        waitpid(pid, &st, 0);
        return WIFEXITED(st) && !WEXITSTATUS(st) && p[66] == 'v' ? 0 : 3;
    }
    if (!strcmp(how, "thread")) {
        pthread_t t;
        if (pthread_create(&t, 0, stamper, (void*) p)) return 2;
        pthread_join(t, 0);
        return p[67] == 't' ? 0 : 3;
    }
    char at[32];
    snprintf(at, sizeof at, "%p", (void*) p);
    char* poke[] = {"isolation", "poke", at, NULL};
    /* the child's program has a memory of its own: the store lands in its own
     * bytes, or past the end of that memory (an address above everything it
     * maps) and ends it */
    int got = run(poke);
    return got == 128 + SIGSEGV || (own_mode() && got == 0) ? 0 : 3;
}

static int run_mode(
    const char* mode, const char* kind, const char* arg, const char* how
) {
    char* args[] = {"isolation", (char*) mode, (char*) kind,
                    (char*) arg, (char*) how,  NULL};
    return run(args);
}

/* as uid 1000, against the root process's mapping of an object of this kind */
static void of_kind(const char* kind, const char* arg, char* addr) {
    char at[32];
    snprintf(at, sizeof at, "%p", (void*) addr);
    char* poke[] = {"isolation", "poke", at, NULL};
    char* peek[] = {"isolation", "peek", at, NULL};
    int fds[2];
    pipe(fds);
    check(
        kind, "a non-member's store ends it with SIGSEGV",
        run(poke) == 128 + SIGSEGV
    );
    check(
        kind, "a non-member's load ends it with SIGSEGV",
        run(peek) == 128 + SIGSEGV
    );
    check(
        kind, "a non-member's syscall reading it is refused",
        write(fds[1], addr, 16) < 0 && errno == EFAULT
    );
    write(fds[1], "0123456789abcdef", 16);
    check(
        kind, "a non-member's syscall writing it is refused",
        read(fds[0], addr, 16) < 0 && errno == EFAULT
    );
    check(
        kind, "a member stores, loads and passes it to syscalls",
        run_mode("member", kind, arg, 0) == 0
    );
    check(
        kind, "a store after detach ends it with SIGSEGV",
        run_mode("detached", kind, arg, "store") == 128 + SIGSEGV
    );
    check(
        kind, "a load after detach ends it with SIGSEGV",
        run_mode("detached", kind, arg, "load") == 128 + SIGSEGV
    );
    check(
        kind, "a syscall after detach is refused",
        run_mode("detached", kind, arg, "sys") == 0
    );
    check(
        kind, "a vfork child shares the membership",
        run_mode("inherit", kind, arg, "vfork") == 0
    );
    check(
        kind, "a thread shares the membership",
        run_mode("inherit", kind, arg, "thread") == 0
    );
    check(
        kind, "a program the child execs is a non-member",
        run_mode("inherit", kind, arg, "exec") == 0
    );
    check(
        kind, "a store still ends it after a member exited holding the mapping",
        run_mode("held", kind, arg, 0) == 0 && run(poke) == 128 + SIGSEGV
    );
}

/* as uid 1000 in a memory of its own, against the root process's mapping of an
 * object of this kind: nothing of root's is at the address, and nothing the
 * process does there is root's */
static void of_kind_own(const char* kind, const char* arg, char* addr) {
    char at[32];
    snprintf(at, sizeof at, "%p", (void*) addr);
    check(
        kind,
        "a non-member's loads, stores and syscalls reach only its own bytes",
        reach(addr) == 0
    );
    check(
        kind, "a member stores, loads and passes it to syscalls",
        run_mode("member", kind, arg, 0) == 0
    );
    check(
        kind, "a store after detach reaches only its own bytes",
        run_mode("detached", kind, arg, "store") == 0
    );
    check(
        kind, "a load after detach reaches only its own bytes",
        run_mode("detached", kind, arg, "load") == 0
    );
    check(
        kind, "a syscall after detach reaches only its own bytes",
        run_mode("detached", kind, arg, "sys") == 0
    );
    check(
        kind, "a vfork child shares the membership",
        run_mode("inherit", kind, arg, "vfork") == 0
    );
    check(
        kind, "a thread shares the membership",
        run_mode("inherit", kind, arg, "thread") == 0
    );
    check(
        kind, "a program the child execs has a memory of its own",
        run_mode("inherit", kind, arg, "exec") == 0
    );
}

/* as uid 1000 in a memory of its own: the kernel's memory (`kaddr`), another
 * process's and a segment it never attached are not reachable; every access
 * lands in this process's bytes and root checks afterwards that its own did not
 * change. `objects` is as in nonroot() */
static int nonroot_own(
    char* other, char* shared, char* open_id, char* kaddr, char** objects
) {
    void* theirs = (void*) strtoul(other, 0, 0);
    int fds[2];
    pipe(fds);
    write(fds[1], "0123456789abcdef0123456789abcdef", 32);
    CHECK(
        "nonroot syscall on its own memory",
        read(fds[0], own, 32) == 32 && !memcmp(own, "0123456789abcdef", 16)
    );
    char* own_poke[] = {"isolation", "poke", "own", NULL};
    char* own_peek[] = {"isolation", "peek", "own", NULL};
    CHECK("nonroot store to its own memory", run(own_poke) == 0);
    CHECK("nonroot load from its own memory", run(own_peek) == 0);
    CHECK(
        "nonroot loads, stores and syscalls at a kernel address reach only its "
        "own bytes",
        reach((char*) strtoul(kaddr, 0, 0)) == 0
    );
    CHECK(
        "nonroot loads, stores and syscalls at another process's address reach "
        "only its own bytes",
        reach((char*) theirs) == 0
    );
    CHECK(
        "nonroot loads, stores and syscalls at a segment it never attached "
        "reach only its own bytes",
        reach((char*) strtoul(shared, 0, 0)) == 0
    );
    char* attach[] = {"isolation", "attach", open_id, NULL};
    CHECK("nonroot store and load in a segment it attached", run(attach) == 0);
    char* unmapped[] = {"isolation", "revoke", "munmap", NULL};
    char* unmapped_syscall[] = {"isolation", "revoke", "syscall", NULL};
    char* detached[] = {"isolation", "revoke", "shmdt", NULL};
    CHECK(
        "nonroot load after a sibling unmaps the page reads its own bytes",
        run(unmapped) == 0
    );
    CHECK(
        "nonroot load after a sibling unmaps the page during a syscall reads "
        "its own bytes",
        run(unmapped_syscall) == 0
    );
    CHECK(
        "nonroot load after a sibling detaches the segment reads its own bytes",
        run(detached) == 0
    );
    void* mine = mmap(
        0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    void* fixed = mmap(
        mine, 4096, PROT_READ, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0
    );
    CHECK("MAP_FIXED refused", fixed == MAP_FAILED && errno == EINVAL);
    for (; objects[0]; objects += 3)
        of_kind_own(objects[0], objects[1], (char*) strtoul(objects[2], 0, 0));
    return 0;
}

/* as uid 1000: the kernel's memory, another process's and a segment it never
 * attached refused, to syscalls, loads and stores; a segment it attaches is
 * open (SECURITY.md); then each kind of shared object, which is theirs to
 * reach only once they map it. `objects` is kind, argument and the root
 * process's address, three arguments each */
static int nonroot(char* other, char* shared, char* open_id, char** objects) {
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
    for (; objects[0]; objects += 3)
        of_kind(objects[0], objects[1], (char*) strtoul(objects[2], 0, 0));
    return 0;
}

/* creates an object of the kind and maps it in this process; its name goes to
 * `arg` */
static char* make_object(const char* kind, char* arg, size_t n) {
    int fd = -1;
    if (!strcmp(kind, "sysv")) {
        snprintf(arg, n, "%d", shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666));
    }
    else if (!strcmp(kind, "posix")) {
        mkdir("/dev/shm", 01777);
        snprintf(arg, n, "/gmux-isolation");
        fd = shm_open(arg, O_CREAT | O_RDWR, 0666);
    }
    else if (!strcmp(kind, "file")) {
        snprintf(arg, n, "/tmp/isolation-shared");
        fd = open(arg, O_CREAT | O_RDWR | O_TRUNC, 0666);
    }
    else
        snprintf(arg, n, "-");
    if (fd >= 0) {
        fchmod(fd, 0666);
        ftruncate(fd, 4096);
        close(fd);
    }
    return map_kind(kind, arg);
}

static void remove_object(const char* kind, const char* arg, char* addr) {
    unmap_kind(kind, addr);
    if (!strcmp(kind, "sysv")) shmctl(atoi(arg), IPC_RMID, 0);
    if (!strcmp(kind, "posix")) shm_unlink(arg);
    if (!strcmp(kind, "file")) unlink(arg);
}

/* runs this program again as uid 1000: the exit status, or 128 + the signal */
static int run_as_nonroot(char* const* args) {
    int st = -1;
    pid_t pid = vfork();
    if (pid == 0) {
        if (setuid(1000) == 0) execv("/bin/isolation", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    return WIFSIGNALED(st) ? 128 + WTERMSIG(st) : WEXITSTATUS(st);
}

/* a new 16 KiB file, all of it mapped here */
static char* map_whole(const char* name) {
    int fd = open(name, O_CREAT | O_RDWR | O_TRUNC, 0666);
    char* p = MAP_FAILED;
    if (fd >= 0 && !fchmod(fd, 0666) && !ftruncate(fd, 16384))
        p = mmap(0, 16384, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (fd >= 0) close(fd);
    return p;
}

static void check_halves(void) {
    char name[] = "/tmp/isolation-halves";
    char* whole = map_whole(name);
    char* args[] = {"isolation", "halves", name, NULL};
    check(
        "file", "unmapping one of a region's two mappings keeps the other's",
        whole != MAP_FAILED && status(run_as_nonroot(args)) == 0
    );
    if (whole != MAP_FAILED) munmap(whole, 16384);
    unlink(name);
}

/* a region's pages are all untagged once its last mapping goes, even when that
 * mapping covered only some of them: an object that takes the freed id must
 * not reach the rest. Root maps a file, uid 1000 maps its middle, root unmaps
 * the file, then uid 1000 unmaps the middle and maps another file */
static int span_once(int last) {
    char name[] = "/tmp/isolation-span", other[] = "/tmp/isolation-other";
    char* whole = map_whole(name);
    int fd = open(other, O_CREAT | O_RDWR | O_TRUNC, 0666);
    int up[2], down[2];
    if (fd >= 0) {
        fchmod(fd, 0666);
        ftruncate(fd, 4096);
        close(fd);
    }
    if (whole == MAP_FAILED || pipe(up) || pipe(down)) return 0;
    char at[32], ends[4], from[8], to[8];
    snprintf(at, sizeof at, "%p", (void*) whole);
    snprintf(ends, sizeof ends, "%d", last);
    snprintf(from, sizeof from, "%d", up[1]);
    snprintf(to, sizeof to, "%d", down[0]);
    char* args[] = {"isolation", "stale", name, other, at,
                    ends,        from,    to,   NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        if (setuid(1000) == 0) execv("/bin/isolation", args);
        _exit(127);
    }
    close(up[1]);
    close(down[0]);
    char c;
    int ready = read(up[0], &c, 1) == 1;
    munmap(whole, 16384);
    write(down[1], "g", 1);
    int st = -1;
    waitpid(pid, &st, 0);
    close(up[0]);
    close(down[1]);
    unlink(name);
    unlink(other);
    /* in a memory of its own the store lands in the process's own bytes */
    int ok = ready && (own_mode() ? WIFEXITED(st) && !WEXITSTATUS(st)
                                  : WIFSIGNALED(st) && WTERMSIG(st) == SIGSEGV);
    if (!ok) printf("ready %d, wait status %d\n", ready, st);
    return ok;
}

enum
{
    HELD = 4000,
    CYCLES = 150,
    MAX_MAPPINGS = 4400
};
static char* mapped[MAX_MAPPINGS + 1];

/* the i'th file of /tmp mapped shared, 4 KiB; its path goes to `path` */
static char* map_numbered(int i, char* path, size_t n) {
    snprintf(path, n, "/tmp/isolation-r%d", i);
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0666);
    int ok = fd >= 0 && !ftruncate(fd, 4096);
    if (fd >= 0) close(fd);
    return ok ? map_kind("file", path) : MAP_FAILED;
}

/* region ids run out at 4,095 shared mappings at once: the next is refused,
 * not opened to everyone, and a detach or an exit gives its id back */
static void regions(void) {
    char path[48], spare[48];
    int i, n = 0, ok = 1;
    for (; n < HELD && ok; n++)
        ok = (mapped[n] = map_numbered(n, path, sizeof path)) != MAP_FAILED;
    check("regions", "4,000 shared mappings at once", ok);
    char* p = map_numbered(n, spare, sizeof spare);
    ok = p != MAP_FAILED && !unmap_kind("file", p);
    n++;
    for (i = 0; ok && i < CYCLES; i++) {
        p = map_kind("file", spare);
        ok = p != MAP_FAILED && !unmap_kind("file", p);
    }
    check("regions", "150 attach and detach cycles reuse an id", ok);
    for (i = 0; ok && i < CYCLES; i++)
        ok = run_mode("held", "file", spare, 0) == 0;
    check("regions", "150 exits holding a mapping give its id back", ok);
    int failed = 0;
    for (; n < MAX_MAPPINGS && !failed; n++) {
        mapped[n] = map_numbered(n, path, sizeof path);
        failed = mapped[n] == MAP_FAILED;
    }
    check(
        "regions", "the mapping past the last id is refused",
        failed && errno == ENOMEM
    );
    int seg = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666);
    struct shmid_ds ds;
    char* attached = seg >= 0 ? shmat(seg, 0, 0) : MAP_FAILED;
    check(
        "regions", "a refused shmat leaves the segment unattached",
        attached == MAP_FAILED && errno == ENOMEM &&
            shmctl(seg, IPC_STAT, &ds) == 0 && ds.shm_nattch == 0
    );
    shmctl(seg, IPC_RMID, 0);
    if (!failed) {
        char at[32];
        snprintf(at, sizeof at, "%p", (void*) mapped[n - 1]);
        char* poke[] = {"isolation", "poke", at, NULL};
        printf(
            "TRUST mapping %d is %s to a non-root store\n", n,
            run_as_nonroot(poke) == 0 ? "open" : "closed"
        );
    }
    for (i = 0; i < n; i++) {
        if (mapped[i] && mapped[i] != MAP_FAILED) munmap(mapped[i], 4096);
        snprintf(path, sizeof path, "/tmp/isolation-r%d", i);
        unlink(path);
    }
}

static char* kern;
static unsigned char kbefore[16];

/* a window of the kernel's static data (the first 192 KiB from 0x10000, below
 * the pages processes are given) that is not all zero and does not change over
 * 150 ms: what a process in the machine's memory reads, and one in its own does
 * not */
static void find_kernel(void) {
    enum
    {
        WANT = 64
    };
    char* at[WANT];
    unsigned char first[WANT][16];
    int n = 0;
    for (char* p = (char*) 0x10000; p < (char*) 0x40000 && n < WANT; p += 16) {
        int set = 0;
        for (int i = 0; i < 16; i++) set += p[i] != 0;
        if (set < 8) continue;
        at[n] = p;
        memcpy(first[n++], p, 16);
    }
    usleep(150000);
    for (int i = 0; i < n && !kern; i++)
        if (!memcmp(first[i], at[i], 16)) kern = at[i];
    if (kern)
        printf(
            "kernel window at 0x10000 + %lu\n",
            (unsigned long) (kern - (char*) 0x10000)
        );
}

/* a command as uid 1000, by fork or vfork, which sets the uid and execs: its
 * exit status, or 128 + the signal */
static int launch(int forked, const char* path, char* const* args) {
    int st = -1;
    pid_t pid = forked ? fork() : vfork();
    if (pid == 0) {
        if (setuid(1000) == 0) execv(path, args);
        _exit(127);
    }
    if (pid < 0) return 100 + errno;
    waitpid(pid, &st, 0);
    return WIFSIGNALED(st) ? 128 + WTERMSIG(st) : WEXITSTATUS(st);
}

/* a copy of this program that is setuid root */
static int suid_copy(const char* dst) {
    char buf[4096];
    ssize_t n = -1;
    int in = open("/bin/isolation", O_RDONLY),
        out = open(dst, O_CREAT | O_WRONLY | O_TRUNC, 0755);
    while (in >= 0 && out >= 0 && (n = read(in, buf, sizeof buf)) > 0)
        if (write(out, buf, n) != n) break;
    int ok = in >= 0 && out >= 0 && n == 0 && !fchmod(out, 04755);
    if (in >= 0) close(in);
    if (out >= 0) close(out);
    return ok;
}

/* what a non-root shell's $(...) and a pipeline command report as their build
 */
static int shell_kinds(const char* kaddr, int want_own) {
    char script[200], out[256] = "";
    char* args[] = {"sh", "-c", script, NULL};
    int fds[2], st = -1;
    snprintf(
        script, sizeof script,
        "x=$(/bin/isolation kind %s); echo \"dollar $x\"; /bin/isolation kind "
        "%s | cat",
        kaddr, kaddr
    );
    if (pipe(fds)) return 0;
    pid_t pid = vfork();
    if (pid == 0) {
        dup2(fds[1], 1);
        if (setuid(1000) == 0) execv("/bin/sh", args);
        _exit(127);
    }
    close(fds[1]);
    ssize_t n = 0, got;
    while (n < (ssize_t) sizeof out - 1 &&
           (got = read(fds[0], out + n, sizeof out - 1 - n)) > 0)
        n += got;
    waitpid(pid, &st, 0);
    close(fds[0]);
    int ok = want_own ? strstr(out, "dollar KIND own\n") &&
                            strstr(out, "\nKIND own\n")
                      : strstr(out, "dollar \n") && !strstr(out, "KIND");
    if (!ok) printf("shell printed \"%s\", status %d\n", out, st);
    return ok;
}

/* each way a uid 1000 process starts reports the build it got: the guarded
 * build ends the probe with SIGSEGV, the plain build in the machine's memory
 * reads kernel bytes, and a memory of its own reads zeros */
static void launch_forms(int owned) {
    char at[32], suid[] = "/tmp/isolation-suid";
    snprintf(at, sizeof at, "%p", (void*) kern);
    int want = owned ? KIND_OWN : 128 + SIGSEGV;
    char* args[] = {"isolation", "kind", at, NULL};
    char* suid_args[] = {"isolation-suid", "kind", at, NULL};
    check(
        "launch", "root forks, the child setuids and execs",
        launch(1, "/bin/isolation", args) == want
    );
    check(
        "launch", "root vforks, the child setuids and execs",
        launch(0, "/bin/isolation", args) == want
    );
    check(
        "launch",
        "uid 1000 runs a setuid-root helper, which is root in the machine's "
        "memory",
        suid_copy(suid) && launch(0, suid, suid_args) == KIND_SHARED
    );
    unlink(suid);
    check(
        "launch", "a non-root shell's $(...) and pipeline commands",
        shell_kinds(at, owned)
    );
    pid_t pid = vfork();
    if (pid == 0) _exit(setuid(1000) ? 127 : kind_code(at));
    int st = -1;
    waitpid(pid, &st, 0);
    printf(
        "TRUST setuid without exec: %s\n",
        WIFEXITED(st) && WEXITSTATUS(st) == KIND_SHARED
            ? "machine's memory, plain build"
            : "other"
    );
}

static int root_flow(char* argv0, int owned);

int main(int argc, char** argv) {
    if (argc == 3 && !strcmp(argv[1], "child"))
        return attach_as_child(atoi(argv[2]));
    if (argc >= 5 && !strcmp(argv[1], "nonroot"))
        return nonroot(argv[2], argv[3], argv[4], argv + 5);
    if (argc >= 6 && !strcmp(argv[1], "ownroot"))
        return nonroot_own(argv[2], argv[3], argv[4], argv[5], argv + 6);
    if (argc == 4 && !strcmp(argv[1], "newowner")) return newowner(argv);
    if (argc == 3 && !strcmp(argv[1], "kind")) {
        int k = kind_code(argv[2]);
        printf("KIND %s\n", k == KIND_OWN ? "own" : "shared");
        return k;
    }
    if (argc >= 4 && !strcmp(argv[1], "member"))
        return member(argv[2], argv[3]);
    if (argc == 5 && !strcmp(argv[1], "detached"))
        return detached(argv[2], argv[3], argv[4]);
    if (argc == 5 && !strcmp(argv[1], "inherit"))
        return inherited(argv[2], argv[3], argv[4]);
    if (argc == 4 && !strcmp(argv[1], "held"))
        return map_kind(argv[2], argv[3]) == MAP_FAILED ? 2 : 0;
    if (argc == 3 && !strcmp(argv[1], "halves")) return halves(argv[2]);
    if (argc == 2 && !strcmp(argv[1], "fork")) {
        pid_t pid = fork();
        if (pid == 0) _exit(0);
        if (pid < 0) return 100 + errno;
        int st = -1;
        waitpid(pid, &st, 0);
        return WIFEXITED(st) ? 0 : 3;
    }
    if (argc == 8 && !strcmp(argv[1], "stale")) return stale(argv + 1);
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

    /* the first pass is the guarded build's, as before; the second runs the
     * same program as uid 1000 in a memory of its own */
    find_kernel();
    if (!kern) {
        printf("FAIL no window of kernel memory to probe\n");
        return 1;
    }
    own_exec(0);
    if (root_flow(argv[0], 0)) return 1;
    own_exec(1);
    setenv("ISOLATION_OWN", "1", 1);
    return root_flow(argv[0], 1);
}

static int root_flow(char* argv0, int owned) {
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
        char* args[] = {argv0, "child", ids, NULL};
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
    if (owned) {
        strcpy(seg, "SEGMARK");
        memcpy(kbefore, kern, 16);
    }
    snprintf(seg_addr, sizeof seg_addr, "%p", (void*) seg);
    char kern_addr[32];
    snprintf(kern_addr, sizeof kern_addr, "%p", (void*) kern);
    /* a segment anyone may attach, which the nonroot process attaches itself */
    int open_seg = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0666);
    CHECK("open segment", open_seg >= 0);
    char open_id[16];
    snprintf(open_id, sizeof open_id, "%d", open_seg);
    /* one object of each kind, mapped here; the nonroot process is handed
     * where */
    static const char* const kinds[] = {"sysv", "posix", "file", "anon"};
    char names[4][64], places[4][32];
    char* at[4];
    char* args[6 + 3 * 4 + 1] = {
        "isolation", owned ? "ownroot" : "nonroot", addr, seg_addr, open_id
    };
    int shown = 5;
    if (owned) args[shown++] = kern_addr;
    for (int k = 0; k < 4; k++) {
        at[k] = make_object(kinds[k], names[k], sizeof names[k]);
        check(kinds[k], "object mapped by root", at[k] != (char*) -1);
        if (at[k] == (char*) -1) continue;
        strcpy(at[k], "root's");
        snprintf(places[k], sizeof places[k], "%p", (void*) at[k]);
        args[shown++] = (char*) kinds[k];
        args[shown++] = names[k];
        args[shown++] = places[k];
    }
    args[shown] = NULL;
    pid = vfork();
    if (pid == 0) {
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
    if (owned) {
        CHECK("root's segment still holds its marker", !strcmp(seg, "SEGMARK"));
        int same = !memcmp(kern, kbefore, 16);
        if (!same)
            for (int i = 0; i < 16; i++)
                printf(
                    "kernel byte %d: %02x then %02x\n", i, kbefore[i],
                    (unsigned char) kern[i]
                );
        CHECK("the kernel's memory is unchanged by the nonroot stores", same);
    }
    shmdt(seg);
    shmctl(seg_id, IPC_RMID, 0);
    shmctl(open_seg, IPC_RMID, 0);
    for (int k = 0; k < 4; k++) {
        if (at[k] == (char*) -1) continue;
        check(kinds[k], "root's object untouched", !strcmp(at[k], "root's"));
        remove_object(kinds[k], names[k], at[k]);
    }
    char* fork_args[] = {"isolation", "fork", NULL};
    printf("TRUST non-root fork status %d\n", run_as_nonroot(fork_args));
    check_halves();
    check(
        "span",
        "a reused region id does not reach the pages a part left tagged",
        span_once(0) && span_once(1)
    );
    launch_forms(owned);
    if (owned)
        check(
            "own",
            "a page unmapped and mapped again by another process holds none of "
            "its bytes",
            new_owner_check()
        );
    regions();
    return 0;
}
