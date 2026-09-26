#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <sys/times.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#if defined(__APPLE__)
    #include <sys/random.h>
#endif

#include "kb.h"

extern char** environ;

#define LINUX_AT_FDCWD (-100)

/* Linux errno values (the same on both guests) for a host errno */
int64_t kb_err(int e) {
    switch (e) {
        case EPERM: return -1;
        case ENOENT: return -2;
        case EINTR: return -4;
        case EIO: return -5;
        case EBADF: return -9;
        case EAGAIN: return -11;
        case ENOMEM: return -12;
        case EACCES: return -13;
        case EFAULT: return -14;
        case EEXIST: return -17;
        case ENOTDIR: return -20;
        case EISDIR: return -21;
        case EINVAL: return -22;
        case EMFILE: return -24;
        case ENOTTY: return -25;
        case ENOSPC: return -28;
        case ESPIPE: return -29;
        case EPIPE: return -32;
        case ERANGE: return -34;
        case ENAMETOOLONG: return -36;
        case ENOSYS: return -38;
        case ENOTEMPTY: return -39;
        case ELOOP: return -40;
        case ESRCH: return -3;
        case ENXIO: return -6;
        case E2BIG: return -7;
        case ENOEXEC: return -8;
        case ECHILD: return -10;
        case EBUSY: return -16;
        case EXDEV: return -18;
        case ENODEV: return -19;
        case ETXTBSY: return -26;
        case EFBIG: return -27;
        case EROFS: return -30;
        case EMLINK: return -31;
        case EDEADLK: return -35;
        case ENOLCK: return -37;
        case EOVERFLOW: return -75;
        case ENOTSOCK: return -88;
        case EDESTADDRREQ: return -89;
        case EMSGSIZE: return -90;
        case EPROTOTYPE: return -91;
        case ENOPROTOOPT: return -92;
        case EPROTONOSUPPORT: return -93;
        case EOPNOTSUPP: return -95;
#if ENOTSUP != EOPNOTSUPP
        case ENOTSUP: return -95;
#endif
        case EAFNOSUPPORT: return -97;
        case EADDRINUSE: return -98;
        case EADDRNOTAVAIL: return -99;
        case ENETDOWN: return -100;
        case ENETUNREACH: return -101;
        case ECONNABORTED: return -103;
        case ECONNRESET: return -104;
        case ENOBUFS: return -105;
        case EISCONN: return -106;
        case ENOTCONN: return -107;
        case ETIMEDOUT: return -110;
        case ECONNREFUSED: return -111;
        case EHOSTUNREACH: return -113;
        case EALREADY: return -114;
        case EINPROGRESS: return -115;
        default: return -5;
    }
}

static int64_t ret(int64_t v) {
    return v < 0 ? kb_err(errno) : v;
}

/* the x86-64 syscall numbers katybug knows, as generic (AArch64) numbers; -1
   for unknown. The non-*at forms become their *at forms in norm() */
static int x86_to_generic(uint64_t n) {
    switch (n) {
        case 0: return 63;    /* read */
        case 1: return 64;    /* write */
        case 3: return 57;    /* close */
        case 5: return 80;    /* fstat */
        case 8: return 62;    /* lseek */
        case 9: return 222;   /* mmap */
        case 10: return 226;  /* mprotect */
        case 11: return 215;  /* munmap */
        case 12: return 214;  /* brk */
        case 13: return 134;  /* rt_sigaction */
        case 14: return 135;  /* rt_sigprocmask */
        case 15: return 139;  /* rt_sigreturn */
        case 62: return 129;  /* kill */
        case 131: return 132; /* sigaltstack */
        case 200: return 130; /* tkill */
        case 234: return 131; /* tgkill */
        case 16: return 29;   /* ioctl */
        case 19: return 65;   /* readv */
        case 20: return 66;   /* writev */
        case 28: return 233;  /* madvise */
        case 32: return 23;   /* dup */
        case 35: return 101;  /* nanosleep */
        case 39: return 172;  /* getpid */
        case 60: return 93;   /* exit */
        case 63: return 160;  /* uname */
        case 72: return 25;   /* fcntl */
        case 79: return 17;   /* getcwd */
        case 80: return 49;   /* chdir */
        case 102: return 174; /* getuid */
        case 104: return 176; /* getgid */
        case 107: return 175; /* geteuid */
        case 108: return 177; /* getegid */
        case 110: return 173; /* getppid */
        case 186: return 178; /* gettid */
        case 218: return 96;  /* set_tid_address */
        case 228: return 113; /* clock_gettime */
        case 231: return 94;  /* exit_group */
        case 257: return 56;  /* openat */
        case 258: return 34;  /* mkdirat */
        case 262: return 79;  /* newfstatat */
        case 263: return 35;  /* unlinkat */
        case 267: return 78;  /* readlinkat */
        case 269: return 48;  /* faccessat */
        case 292: return 24;  /* dup3 */
        case 293: return 59;  /* pipe2 */
        case 302: return 261; /* prlimit64 */
        case 318: return 278; /* getrandom */
        case 217: return 61;  /* getdents64 */
        case 56: return 220;  /* clone */
        case 57: return -4;   /* fork */
        case 58:
            return -4; /* vfork: as fork, which vfork's callers cannot tell
                          apart */
        case 59: return 221;  /* execve */
        case 61: return 260;  /* wait4 */
        case 95: return 166;  /* umask */
        case 109: return 154; /* setpgid */
        case 121: return 155; /* getpgid */
        case 111: return -5;  /* getpgrp */
        case 112: return 157; /* setsid */
        case 124: return 156; /* getsid */
        case 7: return -7;    /* poll */
        case 17: return 67;   /* pread64 */
        case 18: return 68;   /* pwrite64 */
        case 23: return -8;   /* select */
        case 24: return 124;  /* sched_yield */
        case 34: return -9;   /* pause */
        case 36: return 102;  /* getitimer */
        case 37: return -6;   /* alarm */
        case 38: return 103;  /* setitimer */
        case 40: return 71;   /* sendfile */
        case 41: return 198;  /* socket */
        case 42: return 203;  /* connect */
        case 43: return 202;  /* accept */
        case 44: return 206;  /* sendto */
        case 45: return 207;  /* recvfrom */
        case 46: return 211;  /* sendmsg */
        case 47: return 212;  /* recvmsg */
        case 48: return 210;  /* shutdown */
        case 49: return 200;  /* bind */
        case 50: return 201;  /* listen */
        case 51: return 204;  /* getsockname */
        case 52: return 205;  /* getpeername */
        case 53: return 199;  /* socketpair */
        case 54: return 208;  /* setsockopt */
        case 55: return 209;  /* getsockopt */
        case 73: return 32;   /* flock */
        case 74: return 82;   /* fsync */
        case 75: return 83;   /* fdatasync */
        case 76: return 45;   /* truncate */
        case 77: return 46;   /* ftruncate */
        case 81: return 50;   /* fchdir */
        case 91: return 52;   /* fchmod */
        case 93: return 55;   /* fchown */
        case 96: return 169;  /* gettimeofday */
        case 97: return 163;  /* getrlimit */
        case 98: return 165;  /* getrusage */
        case 100: return 153; /* times */
        case 115: return 158; /* getgroups */
        case 127: return 136; /* rt_sigpending */
        case 130: return 133; /* rt_sigsuspend */
        case 137: return 43;  /* statfs */
        case 138: return 44;  /* fstatfs */
        case 157: return 167; /* prctl */
        case 160: return 164; /* setrlimit */
        case 201: return -10; /* time */
        case 204: return 123; /* sched_getaffinity */
        case 222: return 107; /* timer_create */
        case 223: return 110; /* timer_settime */
        case 224: return 108; /* timer_gettime */
        case 225: return 109; /* timer_getoverrun */
        case 226: return 111; /* timer_delete */
        case 229: return 114; /* clock_getres */
        case 230: return 115; /* clock_nanosleep */
        case 260: return 54;  /* fchownat */
        case 264: return 38;  /* renameat */
        case 265: return 37;  /* linkat */
        case 266: return 36;  /* symlinkat */
        case 268: return 53;  /* fchmodat */
        case 270: return 72;  /* pselect6 */
        case 271: return 73;  /* ppoll */
        case 280: return 88;  /* utimensat */
        case 285: return 47;  /* fallocate */
        case 288: return 242; /* accept4 */
        case 316: return 276; /* renameat2 */
        case 439: return 439; /* faccessat2 */
        default: return -1;
    }
}

/* getdents64 through the host's readdir: one DIR per guest descriptor, and an
   entry that did not fit in the last buffer kept for the next call */
static struct {
    DIR* dir;
    struct dirent* held;
} dirs[1024];

static int64_t dents(struct kb_cpu* cpu, int fd, uint64_t buf, uint64_t size) {
    if (fd < 0 || fd >= 1024) return -9;
    if (!dirs[fd].dir) {
        int copy = dup(fd);
        if (copy < 0) return kb_err(errno);
        dirs[fd].dir = fdopendir(copy);
        if (!dirs[fd].dir) {
            close(copy);
            return kb_err(errno);
        }
    }
    uint64_t used = 0;
    for (;;) {
        struct dirent* e =
            dirs[fd].held ? dirs[fd].held : readdir(dirs[fd].dir);
        dirs[fd].held = NULL;
        if (!e) break;
        size_t len = strlen(e->d_name);
        uint64_t rec = (19 + len + 1 + 7) & ~7ull;
        if (used + rec > size) {
            dirs[fd].held = e;
            if (!used) return -22;
            break;
        }
        uint8_t* p = kb_host(cpu, buf + used, rec);
        if (!p) return -14;
        memset(p, 0, rec);
        uint64_t ino = (uint64_t) e->d_ino, off = used + rec;
        uint16_t r16 = (uint16_t) rec;
        memcpy(p, &ino, 8);
        memcpy(p + 8, &off, 8);
        memcpy(p + 16, &r16, 2);
        p[18] = e->d_type;
        memcpy(p + 19, e->d_name, len);
        used += rec;
    }
    return (int64_t) used;
}

static void forget_dir(int fd) {
    if (fd >= 0 && fd < 1024 && dirs[fd].dir) {
        closedir(dirs[fd].dir);
        dirs[fd].dir = NULL;
        dirs[fd].held = NULL;
    }
}

static int host_dirfd(int64_t fd) {
    return fd == LINUX_AT_FDCWD ? AT_FDCWD : (int) fd;
}

/* open flags: the low ones match everywhere Linux runs; O_DIRECTORY and
 * O_NOFOLLOW are per arch */
static int host_oflags(struct kb_cpu* cpu, uint64_t f) {
    int h = (int) (f & 3);
    if (f & 0100) h |= O_CREAT;
    if (f & 0200) h |= O_EXCL;
    if (f & 0400) h |= O_NOCTTY;
    if (f & 01000) h |= O_TRUNC;
    if (f & 02000) h |= O_APPEND;
    if (f & 04000) h |= O_NONBLOCK;
    if (f & 02000000) h |= O_CLOEXEC;
    uint64_t dir = cpu->arch == KB_X86 ? 0200000 : 040000;
    uint64_t nofollow = cpu->arch == KB_X86 ? 0400000 : 0100000;
    if (f & dir) h |= O_DIRECTORY;
    if (f & nofollow) h |= O_NOFOLLOW;
    return h;
}

static int64_t put_stat(struct kb_cpu* cpu, uint64_t buf, struct stat* st) {
    uint8_t out[144] = {0};
    uint64_t* q = (uint64_t*) out;
    uint32_t* d = (uint32_t*) out;
#if defined(__APPLE__)
    int64_t at[6] = {st->st_atimespec.tv_sec, st->st_atimespec.tv_nsec,
                     st->st_mtimespec.tv_sec, st->st_mtimespec.tv_nsec,
                     st->st_ctimespec.tv_sec, st->st_ctimespec.tv_nsec};
#else
    int64_t at[6] = {st->st_atim.tv_sec, st->st_atim.tv_nsec,
                     st->st_mtim.tv_sec, st->st_mtim.tv_nsec,
                     st->st_ctim.tv_sec, st->st_ctim.tv_nsec};
#endif
    size_t n;
    if (cpu->arch == KB_X86) {
        q[0] = (uint64_t) st->st_dev;
        q[1] = (uint64_t) st->st_ino;
        q[2] = (uint64_t) st->st_nlink;
        d[6] = st->st_mode;
        d[7] = st->st_uid;
        d[8] = st->st_gid;
        q[5] = (uint64_t) st->st_rdev;
        q[6] = (uint64_t) st->st_size;
        q[7] = (uint64_t) st->st_blksize;
        q[8] = (uint64_t) st->st_blocks;
        memcpy(&q[9], at, sizeof at);
        n = 144;
    }
    else {
        q[0] = (uint64_t) st->st_dev;
        q[1] = (uint64_t) st->st_ino;
        d[4] = st->st_mode;
        d[5] = (uint32_t) st->st_nlink;
        d[6] = st->st_uid;
        d[7] = st->st_gid;
        q[4] = (uint64_t) st->st_rdev;
        q[6] = (uint64_t) st->st_size;
        d[14] = (uint32_t) st->st_blksize;
        q[8] = (uint64_t) st->st_blocks;
        memcpy(&q[9], at, sizeof at);
        n = 128;
    }
    uint8_t* p = kb_host(cpu, buf, n);
    if (!p) return -14;
    memcpy(p, out, n);
    return 0;
}

char* kb_str(struct kb_cpu* cpu, uint64_t va) {
    /* guest strings live in one mapping: find its end within it */
    uint8_t* p = kb_host(cpu, va, 1);
    if (!p) return NULL;
    for (uint64_t n = 0; n < 4096; n++) {
        uint8_t* c = kb_host(cpu, va + n, 1);
        if (!c) return NULL;
        if (!*c) return (char*) p;
    }
    return NULL;
}

/* the guest's argv or envp as a host array, NULL-terminated */
static char** strings(struct kb_cpu* cpu, uint64_t va, int extra) {
    int n = 0;
    while (va && kb_load(cpu, va + 8 * (uint64_t) n, 8)) n++;
    char** out = calloc((size_t) (n + extra + 1), sizeof *out);
    for (int i = 0; i < n; i++)
        out[extra + i] = kb_str(cpu, kb_load(cpu, va + 8 * (uint64_t) i, 8));
    return out;
}

/* execve: a foreign ELF runs under katybug again, anything else as the host
 * runs it */
static int64_t execve_guest(
    struct kb_cpu* cpu, uint64_t path_va, uint64_t argv_va, uint64_t envp_va
) {
    char* path = kb_str(cpu, path_va);
    if (!path) return -14;
    unsigned char head[20] = {0};
    int fd = open(path, O_RDONLY);
    if (fd < 0) return kb_err(errno);
    ssize_t got = read(fd, head, sizeof head);
    close(fd);
    char** envp = strings(cpu, envp_va, 0);
    int foreign = got == 20 && memcmp(head, "\177ELF\2\1", 6) == 0 &&
                  (head[18] == 62 || head[18] == 183);
    if (!foreign) {
        char** argv = strings(cpu, argv_va, 0);
        execve(path, argv, envp);
        return kb_err(errno);
    }
    /* katybug <path> <argv[1]...>, with the guest's argv[0] carried in
     * KATYBUG_ARGV0 */
    char** argv = strings(cpu, argv_va, 0);
    int k = 0;
    while (argv[k]) k++;
    char** full = calloc((size_t) k + 3, sizeof *full);
    full[0] = (char*) kb_self;
    full[1] = path;
    for (int i = 1; i < k; i++) full[i + 1] = argv[i];
    /* the new katybug keeps this one's own KATYBUG_* settings, which the guest
     * never saw */
    int e = 0, own = 0;
    while (envp[e]) e++;
    while (environ[own]) own++;
    envp = realloc(envp, (size_t) (e + own + 2) * sizeof *envp);
    for (int i = 0; i < own; i++)
        if (strncmp(environ[i], "KATYBUG_", 8) == 0 &&
            strncmp(environ[i], "KATYBUG_ARGV0=", 14) != 0)
            envp[e++] = environ[i];
    char* a0 = malloc(strlen(k ? argv[0] : path) + 16);
    strcpy(a0, "KATYBUG_ARGV0=");
    strcat(a0, k ? argv[0] : path);
    envp[e] = a0;
    envp[e + 1] = NULL;
    execve(kb_self, full, envp);
    return kb_err(errno);
}

static int64_t mmap_anon(
    struct kb_cpu* cpu, uint64_t addr, uint64_t len, uint64_t prot,
    uint64_t flags, int64_t fd, uint64_t off
) {
    uint64_t at = (flags & 0x10)
                      ? addr
                      : cpu->mmap_next; /* MAP_FIXED lays over what is there */
    struct kb_mapping* m = kb_map(cpu, at, len, prot ? (int) prot : 0);
    if (!m) return -12;
    if (!(flags & 0x10)) cpu->mmap_next = m->end + 4096;
    if (!(flags & 0x20) && fd >= 0) /* a file mapping, private: read it in */
    {
        ssize_t got = pread((int) fd, m->host, (size_t) len, (off_t) off);
        if (got < 0) return kb_err(errno);
    }
    return (int64_t) m->start;
}

static int64_t brk_to(struct kb_cpu* cpu, uint64_t want) {
    if (want <= cpu->brk_start) return (int64_t) cpu->brk_end;
    uint64_t end = (want + 0xfffull) & ~0xfffull;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->brk) {
            /* guest pointers are guest addresses, so the host block may move */
            uint8_t* h = realloc(m->host, end - m->start);
            if (!h) return (int64_t) cpu->brk_end;
            if (end > m->end) memset(h + (m->end - m->start), 0, end - m->end);
            m->host = h;
            m->end = end;
            cpu->mapgen++;
            cpu->brk_end = want;
            return (int64_t) want;
        }
    }
    struct kb_mapping* heap =
        kb_map(cpu, cpu->brk_start, end - cpu->brk_start, 3);
    if (!heap) return (int64_t) cpu->brk_end;
    heap->brk = 1;
    cpu->brk_end = want;
    return (int64_t) want;
}

static clockid_t host_clock(uint64_t id) {
    switch (id) {
        case 1:
        case 4:
        case 6:
        case 7: return CLOCK_MONOTONIC;
        case 2:
        case 3: return CLOCK_PROCESS_CPUTIME_ID;
        default: return CLOCK_REALTIME;
    }
}

/* fcntl F_GETLK/F_SETLK/F_SETLKW: struct flock is {short type, whence; off_t
   start, len; pid_t pid} with F_RDLCK 0, F_WRLCK 1, F_UNLCK 2 on Linux */
static int64_t lock(struct kb_cpu* cpu, int fd, int cmd, uint64_t va) {
    static const short types[3] = {F_RDLCK, F_WRLCK, F_UNLCK};
    struct flock fl;
    memset(&fl, 0, sizeof fl);
    uint64_t t = kb_load(cpu, va, 2);
    if (t > 2) return -22;
    fl.l_type = types[t];
    fl.l_whence = (short) kb_load(cpu, va + 2, 2);
    fl.l_start = (off_t) kb_load(cpu, va + 8, 8);
    fl.l_len = (off_t) kb_load(cpu, va + 16, 8);
    if (fcntl(fd, cmd == 5 ? F_GETLK : cmd == 6 ? F_SETLK : F_SETLKW, &fl) < 0)
        return kb_err(errno);
    if (cmd == 5) {
        kb_store(
            cpu, va,
            fl.l_type == F_RDLCK   ? 0
            : fl.l_type == F_WRLCK ? 1
                                   : 2,
            2
        );
        kb_store(cpu, va + 2, (uint64_t) fl.l_whence, 2);
        kb_store(cpu, va + 8, (uint64_t) fl.l_start, 8);
        kb_store(cpu, va + 16, (uint64_t) fl.l_len, 8);
        kb_store(cpu, va + 24, (uint64_t) (uint32_t) fl.l_pid, 4);
    }
    return 0;
}

/* renameat2: flags 0, or RENAME_NOREPLACE (1) */
static int64_t rename_at(
    int od, const char* op, int nd, const char* np, uint64_t flags
) {
    if (flags & ~1ull) return -22;
    if (flags) {
#if defined(__APPLE__)
        return renameatx_np(od, op, nd, np, RENAME_EXCL) < 0 ? kb_err(errno)
                                                             : 0;
#else
        /* ponytail: check-then-rename races; use renameat2 where the host libc
         * has it */
        struct stat st;
        if (fstatat(nd, np, &st, AT_SYMLINK_NOFOLLOW) == 0) return -17;
#endif
    }
    return renameat(od, op, nd, np) < 0 ? kb_err(errno) : 0;
}

/* utimensat(dirfd, path or NULL, timespec[2], flags), or (timeval)
 * utimes/futimesat */
static int64_t utimens(
    struct kb_cpu* cpu, int timeval, int64_t dfd, uint64_t path_va, uint64_t tv,
    uint64_t flags
) {
    struct timespec ts[2];
    for (int i = 0; i < 2; i++) {
        if (!tv) {
            ts[i].tv_sec = 0;
            ts[i].tv_nsec = UTIME_NOW;
            continue;
        }
        ts[i].tv_sec = (time_t) kb_load(cpu, tv + 16 * (uint64_t) i, 8);
        int64_t sub = (int64_t) kb_load(cpu, tv + 16 * (uint64_t) i + 8, 8);
        if (timeval)
            ts[i].tv_nsec = (long) (sub * 1000);
        else
            ts[i].tv_nsec = sub == (1 << 30) - 1   ? UTIME_NOW
                            : sub == (1 << 30) - 2 ? UTIME_OMIT
                                                   : (long) sub;
    }
    if (!path_va) return futimens((int) dfd, ts) < 0 ? kb_err(errno) : 0;
    char* path = kb_str(cpu, path_va);
    if (!path) return -14;
    return utimensat(
               host_dirfd(dfd), path, ts,
               (flags & 0x100) ? AT_SYMLINK_NOFOLLOW : 0
           ) < 0
               ? kb_err(errno)
               : 0;
}

/* Linux struct statfs (x86-64 and AArch64 alike): type, bsize, blocks, bfree,
   bavail, files, ffree, fsid, namelen, frsize, flags; the type is not known
   here and reads 0 */
static int64_t statfs_guest(
    struct kb_cpu* cpu, int by_fd, uint64_t what, uint64_t buf
) {
    struct statvfs sv;
    int rc;
    if (by_fd)
        rc = fstatvfs((int) what, &sv);
    else {
        char* path = kb_str(cpu, what);
        if (!path) return -14;
        rc = statvfs(path, &sv);
    }
    if (rc < 0) return kb_err(errno);
    uint64_t f[15] = {0,           sv.f_bsize,  sv.f_blocks,
                      sv.f_bfree,  sv.f_bavail, sv.f_files,
                      sv.f_ffree,  sv.f_fsid,   sv.f_namemax,
                      sv.f_frsize, 0,           0,
                      0,           0,           0};
    for (int i = 0; i < 15; i++) kb_store(cpu, buf + 8 * (uint64_t) i, f[i], 8);
    return 0;
}

/* sendfile through a buffer: from *offp (then advanced) or the input's own
 * offset */
static int64_t sendfile_guest(
    struct kb_cpu* cpu, int out, int in, uint64_t offp, uint64_t count
) {
    char buf[65536];
    int64_t done = 0;
    off_t off = offp ? (off_t) kb_load(cpu, offp, 8) : 0;
    while ((uint64_t) done < count) {
        size_t want = count - (uint64_t) done < sizeof buf
                          ? (size_t) (count - (uint64_t) done)
                          : sizeof buf;
        ssize_t got = offp ? pread(in, buf, want, off) : read(in, buf, want);
        if (got < 0) return done ? done : kb_err(errno);
        if (!got) break;
        ssize_t put = write(out, buf, (size_t) got);
        if (put < 0) return done ? done : kb_err(errno);
        off += put;
        done += put;
        if (put < got) {
            if (!offp) lseek(in, put - got, SEEK_CUR);
            break;
        }
    }
    if (offp) kb_store(cpu, offp, (uint64_t) off, 8);
    return done;
}

/* Linux resource numbers to the host's, and RLIM_INFINITY both ways */
static int64_t rlimit(struct kb_cpu* cpu, int res, uint64_t nv, uint64_t ov) {
    static const int map[] = {RLIMIT_CPU,   RLIMIT_FSIZE,  RLIMIT_DATA,
                              RLIMIT_STACK, RLIMIT_CORE,   -1,
                              -1,           RLIMIT_NOFILE, -1,
                              RLIMIT_AS};
    if (res < 0 || res > 9 || map[res] < 0) return -22;
    struct rlimit rl;
    if (getrlimit(map[res], &rl) < 0) return kb_err(errno);
    if (ov) {
        kb_store(
            cpu, ov,
            rl.rlim_cur == RLIM_INFINITY ? ~0ull : (uint64_t) rl.rlim_cur, 8
        );
        kb_store(
            cpu, ov + 8,
            rl.rlim_max == RLIM_INFINITY ? ~0ull : (uint64_t) rl.rlim_max, 8
        );
    }
    if (nv) {
        uint64_t c = kb_load(cpu, nv, 8), m = kb_load(cpu, nv + 8, 8);
        rl.rlim_cur = c == ~0ull ? RLIM_INFINITY : (rlim_t) c;
        rl.rlim_max = m == ~0ull ? RLIM_INFINITY : (rlim_t) m;
        if (setrlimit(map[res], &rl) < 0) return kb_err(errno);
    }
    return 0;
}

void kb_syscall(struct kb_cpu* cpu) {
    uint64_t* r = cpu->r;
    int x86 = cpu->arch == KB_X86;
    uint64_t guest = x86 ? r[0] : r[8];
    int64_t nr = x86 ? x86_to_generic(r[0]) : (int64_t) r[8];
    uint64_t a[6];
    if (x86) {
        uint64_t x[6] = {r[7], r[6], r[2], r[10], r[8], r[9]};
        memcpy(a, x, sizeof a);
        /* the forms without *at */
        switch (r[0]) {
            case 2: /* open */
                a[3] = a[2], a[2] = a[1], a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD;
                nr = 56;
                break;
            case 4:
            case 6: /* stat, lstat */
                a[2] = a[1], a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD;
                a[3] = r[0] == 6 ? 0x100 : 0;
                nr = 79;
                break;
            case 21: /* access */
                a[2] = a[1], a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD,
                a[3] = 0;
                nr = 48;
                break;
            case 22: a[1] = 0, nr = 59; break; /* pipe */
            case 33:                           /* dup2 */
                nr = a[0] == a[1] ? -2 : 24;
                a[2] = 0;
                break;
            case 83:
                a[2] = a[1], a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD,
                nr = 34;
                break;
            case 87:
                a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD, a[2] = 0,
                nr = 35;
                break;
            case 89:
                a[3] = a[2], a[2] = a[1], a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD, nr = 78;
                break;
            case 158: nr = -3; break; /* arch_prctl */
            case 82:
                a[3] = a[1], a[2] = (uint64_t) LINUX_AT_FDCWD, a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD, nr = 38;
                break; /* rename */
            case 84:
                a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD, a[2] = 0x200,
                nr = 35;
                break; /* rmdir */
            case 85:   /* creat */
                a[3] = a[1], a[2] = 01101, a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD;
                nr = 56;
                break;
            case 86: /* link */
                a[3] = a[1], a[2] = (uint64_t) LINUX_AT_FDCWD, a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD, a[4] = 0;
                nr = 37;
                break;
            case 88:
                a[2] = a[1], a[1] = (uint64_t) LINUX_AT_FDCWD, nr = 36;
                break; /* symlink */
            case 90:
                a[2] = a[1], a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD,
                a[3] = 0, nr = 53;
                break; /* chmod */
            case 92:
            case 94: /* chown, lchown */
                a[3] = a[2], a[2] = a[1], a[1] = a[0],
                a[0] = (uint64_t) LINUX_AT_FDCWD;
                a[4] = r[0] == 94 ? 0x100 : 0;
                nr = 54;
                break;
            case 235:
                a[2] = a[1], a[1] = a[0], a[0] = (uint64_t) LINUX_AT_FDCWD,
                nr = -11;
                break;                 /* utimes */
            case 261: nr = -11; break; /* futimesat */
        }
        r[1] = cpu->pc; /* syscall leaves rcx = return address, r11 = flags */
        r[11] = 0x246;
    }
    else {
        uint64_t x[6] = {r[0], r[1], r[2], r[3], r[4], r[5]};
        memcpy(a, x, sizeof a);
    }
    int64_t v;
    switch (nr) {
        case -2: v = (int64_t) a[0]; break; /* dup2 of an fd to itself */
        case -3:                            /* arch_prctl */
            if (a[0] == 0x1002)
                cpu->fs = a[1], v = 0;
            else if (a[0] == 0x1003) {
                kb_store(cpu, a[1], cpu->fs, 8);
                v = 0;
            }
            else
                v = -22;
            break;
        case 63:
        case 64: {
            uint8_t* p = kb_host(cpu, a[1], a[2]);
            if (!p && a[2]) {
                v = -14;
                break;
            }
            v =
                ret(nr == 63 ? read((int) a[0], p, (size_t) a[2])
                             : write((int) a[0], p, (size_t) a[2]));
            break;
        }
        case 65:
        case 66: {
            v = 0;
            for (uint64_t k = 0; k < a[2]; k++) {
                uint64_t base = kb_load(cpu, a[1] + 16 * k, 8);
                uint64_t len = kb_load(cpu, a[1] + 16 * k + 8, 8);
                uint8_t* p = kb_host(cpu, base, len);
                if (!p && len) {
                    v = v ? v : -14;
                    break;
                }
                ssize_t got = nr == 65 ? read((int) a[0], p, (size_t) len)
                                       : write((int) a[0], p, (size_t) len);
                if (got < 0) {
                    v = v ? v : kb_err(errno);
                    break;
                }
                v += got;
                if ((uint64_t) got < len) break;
            }
            break;
        }
        case 56: {
            char* path = kb_str(cpu, a[1]);
            v = path ? ret(openat(
                           host_dirfd((int64_t) a[0]), path,
                           host_oflags(cpu, a[2]), (int) a[3]
                       ))
                     : -14;
            break;
        }
        case 57:
            forget_dir((int) a[0]);
            v = ret(close((int) a[0]));
            break;
        case 61: v = dents(cpu, (int) a[0], a[1], a[2]); break;
        case 62:
            v = ret((int64_t) lseek((int) a[0], (off_t) a[1], (int) a[2]));
            break;
        case 23: v = ret(dup((int) a[0])); break;
        case 24: v = ret(dup2((int) a[0], (int) a[1])); break;
        case 25: /* fcntl: duplicates, the descriptor flag and status flags */
            if (a[1] == 0)
                v = ret(fcntl((int) a[0], F_DUPFD, (int) a[2]));
            else if (a[1] == 1030)
                v = ret(fcntl((int) a[0], F_DUPFD_CLOEXEC, (int) a[2]));
            else if (a[1] == 1)
                v = ret(fcntl((int) a[0], F_GETFD));
            else if (a[1] == 2)
                v = ret(fcntl((int) a[0], F_SETFD, (int) a[2]));
            else if (a[1] == 3) {
                int f = fcntl((int) a[0], F_GETFL);
                v = f < 0 ? kb_err(errno)
                          : (f & O_ACCMODE) | ((f & O_APPEND) ? 02000 : 0) |
                                ((f & O_NONBLOCK) ? 04000 : 0);
            }
            else if (a[1] == 4) {
                int f = fcntl((int) a[0], F_GETFL);
                f = (f & ~(O_APPEND | O_NONBLOCK)) |
                    ((a[2] & 02000) ? O_APPEND : 0) |
                    ((a[2] & 04000) ? O_NONBLOCK : 0);
                v = ret(fcntl((int) a[0], F_SETFL, f));
            }
            else if (a[1] >= 5 && a[1] <= 7)
                v = lock(cpu, (int) a[0], (int) a[1], a[2]);
            else
                v = -22;
            break;
        case 29: /* ioctl: the window size and terminal queries musl makes */
            if (a[1] == 0x5413) {
                struct winsize ws;
                if (ioctl((int) a[0], TIOCGWINSZ, &ws) < 0)
                    v = kb_err(errno);
                else {
                    uint8_t* p = kb_host(cpu, a[2], 8);
                    if (p) memcpy(p, &ws, 8);
                    v = p ? 0 : -14;
                }
            }
            else if (a[1] == 0x5421) /* FIONBIO */
            {
                int f = fcntl((int) a[0], F_GETFL);
                f = kb_load(cpu, a[2], 4) ? f | O_NONBLOCK : f & ~O_NONBLOCK;
                v = ret(fcntl((int) a[0], F_SETFL, f));
            }
            else if (a[1] == 0x541b) /* FIONREAD */
            {
                int n = 0;
                v = ioctl((int) a[0], FIONREAD, &n) < 0 ? kb_err(errno) : 0;
                if (!v) kb_store(cpu, a[2], (uint64_t) (uint32_t) n, 4);
            }
            else
                v = isatty((int) a[0]) ? -22 : -25;
            break;
        case 79:
        case 80: {
            struct stat st;
            int rc;
            if (nr == 80)
                rc = fstat((int) a[0], &st);
            else {
                char* path = kb_str(cpu, a[1]);
                if (!path) {
                    v = -14;
                    break;
                }
                if (!*path && (a[3] & 0x1000))
                    rc = fstat((int) a[0], &st); /* AT_EMPTY_PATH */
                else
                    rc = fstatat(
                        host_dirfd((int64_t) a[0]), path, &st,
                        (a[3] & 0x100) ? AT_SYMLINK_NOFOLLOW : 0
                    );
            }
            v = rc < 0 ? kb_err(errno)
                       : put_stat(cpu, nr == 80 ? a[1] : a[2], &st);
            break;
        }
        case 48: {
            char* path = kb_str(cpu, a[1]);
            v = path ? ret(faccessat(
                           host_dirfd((int64_t) a[0]), path, (int) a[2], 0
                       ))
                     : -14;
            break;
        }
        case 17: {
            uint8_t* p = kb_host(cpu, a[0], a[1]);
            v = p && getcwd((char*) p, (size_t) a[1])
                    ? (int64_t) strlen((char*) p) + 1
                    : kb_err(errno);
            break;
        }
        case 49: {
            char* path = kb_str(cpu, a[0]);
            v = path ? ret(chdir(path)) : -14;
            break;
        }
        case 34: {
            char* path = kb_str(cpu, a[1]);
            v = path ? ret(mkdirat(
                           host_dirfd((int64_t) a[0]), path, (mode_t) a[2]
                       ))
                     : -14;
            break;
        }
        case 35: {
            char* path = kb_str(cpu, a[1]);
            v = path ? ret(unlinkat(
                           host_dirfd((int64_t) a[0]), path,
                           (a[2] & 0x200) ? AT_REMOVEDIR : 0
                       ))
                     : -14;
            break;
        }
        case 78: {
            char* path = kb_str(cpu, a[1]);
            uint8_t* p = kb_host(cpu, a[2], a[3]);
            v = path && p ? ret(readlinkat(
                                host_dirfd((int64_t) a[0]), path, (char*) p,
                                (size_t) a[3]
                            ))
                          : -14;
            break;
        }
        case 59: {
            int fds[2];
            if (pipe(fds) < 0) {
                v = kb_err(errno);
                break;
            }
            kb_store(cpu, a[0], (uint64_t) (uint32_t) fds[0], 4);
            kb_store(cpu, a[0] + 4, (uint64_t) (uint32_t) fds[1], 4);
            v = 0;
            break;
        }
        case 93:
        case 94:
            cpu->exited = 1;
            cpu->status = (int) (a[0] & 0xff);
            return;
        case -4: v = kb_fork_by_exec() ? kb_fork(cpu) : ret(fork()); break;
        case 220: /* clone: only the fork-like form (a signal to the parent, no
                     shared memory) */
            v = (a[0] & ~0xffull)   ? -38
                : kb_fork_by_exec() ? kb_fork(cpu)
                                    : ret(fork());
            break;
        case 221: v = execve_guest(cpu, a[0], a[1], a[2]); break;
        case 260: {
            int st = 0;
            pid_t p = waitpid(
                (pid_t) (int64_t) a[0], a[1] ? &st : NULL,
                (int) a[2] & (WNOHANG | WUNTRACED)
            );
            if (p > 0 && a[1]) kb_store(cpu, a[1], (uint64_t) (uint32_t) st, 4);
            v = ret(p);
            break;
        }
        case 166: v = umask((mode_t) a[0]); break;
        case 154: v = ret(setpgid((pid_t) a[0], (pid_t) a[1])); break;
        case 155: v = ret(getpgid((pid_t) a[0])); break;
        case -5: v = getpgrp(); break;
        case 157: v = ret(setsid()); break;
        case 156: v = ret(getsid((pid_t) a[0])); break;
        case 96: v = getpid(); break;
        case 172: v = getpid(); break;
        case 173: v = getppid(); break;
        case 174: v = getuid(); break;
        case 175: v = geteuid(); break;
        case 176: v = getgid(); break;
        case 177: v = getegid(); break;
        case 178: v = getpid(); break;
        case 134: v = kb_sigaction(cpu, (int) a[0], a[1], a[2]); break;
        case 135: v = kb_sigprocmask(cpu, (int) a[0], a[1], a[2]); break;
        case 139: kb_sigreturn(cpu); return;
        case 132:
            v = 0;
            break; /* sigaltstack: handlers run on the thread's stack */
        case 129:  /* kill: this process or its group signals itself; others
                      through the host */
            if ((int64_t) a[0] == getpid() || a[0] == 0) {
                kb_raise(cpu, (int) a[1], 0);
                v = 0;
            }
            else
                v = ret(kill((pid_t) a[0], kb_host_sig((int) a[1])));
            break;
        case 130:
        case 131: /* tkill, tgkill: one thread, so this process */
            kb_raise(cpu, (int) a[nr == 131 ? 2 : 1], -6);
            v = 0;
            break;
        case 214: v = brk_to(cpu, a[0]); break;
        case 222:
            v = mmap_anon(cpu, a[0], a[1], a[2], a[3], (int64_t) a[4], a[5]);
            break;
        case 215: v = kb_unmap(cpu, a[0], a[1]) ? -12 : 0; break;
        case 226:
            kb_protect(cpu, a[0], a[1], (int) a[2]);
            v = 0;
            break;
        case 233: v = 0; break;
        case 160: {
            uint8_t* p = kb_host(cpu, a[0], 6 * 65);
            if (!p) {
                v = -14;
                break;
            }
            memset(p, 0, 6 * 65);
            strcpy((char*) p, "Linux");
            strcpy((char*) p + 65, "gmux");
            strcpy((char*) p + 130, "6.0.0-katybug");
            strcpy((char*) p + 195, "#1");
            strcpy((char*) p + 260, x86 ? "x86_64" : "aarch64");
            v = 0;
            break;
        }
        case 113: {
            struct timespec ts;
            if (clock_gettime(host_clock(a[0]), &ts) < 0) {
                v = kb_err(errno);
                break;
            }
            kb_store(cpu, a[1], (uint64_t) ts.tv_sec, 8);
            kb_store(cpu, a[1] + 8, (uint64_t) ts.tv_nsec, 8);
            v = 0;
            break;
        }
        case 101: {
            struct timespec ts = {
                (time_t) kb_load(cpu, a[0], 8), (long) kb_load(cpu, a[0] + 8, 8)
            };
            v = ret(nanosleep(&ts, NULL));
            break;
        }
        case 278: {
            uint8_t* p = kb_host(cpu, a[0], a[1]);
            if (!p) {
                v = -14;
                break;
            }
            size_t n = a[1] > 256 ? 256 : (size_t) a[1];
            v = getentropy(p, n) < 0 ? kb_err(errno) : (int64_t) n;
            break;
        }
        case 32: v = ret(flock((int) a[0], (int) a[1])); break;
        case 36:
        case 38:
        case 276:
        case 37: {
            char* p1 = kb_str(cpu, nr == 36 ? a[0] : a[1]);
            char* p2 = kb_str(cpu, nr == 36 ? a[2] : a[3]);
            if (!p1 || !p2) {
                v = -14;
                break;
            }
            if (nr == 36)
                v = ret(symlinkat(p1, host_dirfd((int64_t) a[1]), p2));
            else if (nr == 37)
                v = ret(linkat(
                    host_dirfd((int64_t) a[0]), p1, host_dirfd((int64_t) a[2]),
                    p2, (a[4] & 0x400) ? AT_SYMLINK_FOLLOW : 0
                ));
            else
                v = rename_at(
                    host_dirfd((int64_t) a[0]), p1, host_dirfd((int64_t) a[2]),
                    p2, nr == 276 ? a[4] : 0
                );
            break;
        }
        case 43:
        case 44: v = statfs_guest(cpu, nr == 44, a[0], a[1]); break;
        case 45:
        case 46: {
            if (nr == 46) {
                v = ret(ftruncate((int) a[0], (off_t) a[1]));
                break;
            }
            char* path = kb_str(cpu, a[0]);
            v = path ? ret(truncate(path, (off_t) a[1])) : -14;
            break;
        }
        case 47:
            v = -95;
            break; /* fallocate: the filesystem does not support it */
        case 50: v = ret(fchdir((int) a[0])); break;
        case 52: v = ret(fchmod((int) a[0], (mode_t) a[1])); break;
        case 53: {
            char* path = kb_str(cpu, a[1]);
            v = path ? ret(fchmodat(
                           host_dirfd((int64_t) a[0]), path, (mode_t) a[2], 0
                       ))
                     : -14;
            break;
        }
        case 54: {
            char* path = kb_str(cpu, a[1]);
            if (!path) {
                v = -14;
                break;
            }
            if (!*path && (a[4] & 0x1000))
                v = ret(fchown((int) a[0], (uid_t) a[2], (gid_t) a[3]));
            else
                v = ret(fchownat(
                    host_dirfd((int64_t) a[0]), path, (uid_t) a[2],
                    (gid_t) a[3], (a[4] & 0x100) ? AT_SYMLINK_NOFOLLOW : 0
                ));
            break;
        }
        case 55: v = ret(fchown((int) a[0], (uid_t) a[1], (gid_t) a[2])); break;
        case 67:
        case 68: {
            uint8_t* p = kb_host(cpu, a[1], a[2]);
            if (!p && a[2]) {
                v = -14;
                break;
            }
            v =
                ret(nr == 67
                        ? pread((int) a[0], p, (size_t) a[2], (off_t) a[3])
                        : pwrite((int) a[0], p, (size_t) a[2], (off_t) a[3]));
            break;
        }
        case 71:
            v = sendfile_guest(cpu, (int) a[0], (int) a[1], a[2], a[3]);
            break;
        case 81:
            sync();
            v = 0;
            break;
        case 82:
        case 83: v = ret(fsync((int) a[0])); break;
        case 88:
        case -11:
            v = utimens(
                cpu, nr == -11, (int64_t) a[0], a[1], a[2], nr == 88 ? a[3] : 0
            );
            break;
        case 102:
        case 103:
        case -6:
        case 107:
        case 108:
        case 109:
        case 110:
        case 111: v = kb_timer(cpu, nr, a); break;
        case -9: v = kb_sigsuspend(cpu, cpu->sigmask); break;
        case 133: v = kb_sigsuspend(cpu, kb_load(cpu, a[0], 8)); break;
        case 136: v = kb_sigpending(cpu, a[0]); break;
        case 114:
            if (a[1]) {
                kb_store(cpu, a[1], 0, 8);
                kb_store(cpu, a[1] + 8, 1, 8);
            }
            v = 0;
            break;
        case 115: /* clock_nanosleep(clock, flags, req, rem) */
        {
            struct timespec ts =
                                {(time_t) kb_load(cpu, a[2], 8),
                                 (long) kb_load(cpu, a[2] + 8, 8)},
                            now;
            if (a[1] & 1) /* TIMER_ABSTIME */
            {
                clock_gettime(host_clock(a[0]), &now);
                int64_t ns = ((int64_t) ts.tv_sec - now.tv_sec) * 1000000000 +
                             ts.tv_nsec - now.tv_nsec;
                if (ns <= 0) {
                    v = 0;
                    break;
                }
                ts.tv_sec = (time_t) (ns / 1000000000);
                ts.tv_nsec = (long) (ns % 1000000000);
            }
            v = nanosleep(&ts, NULL) < 0 ? -(int64_t) (errno == EINTR ? 4 : 22)
                                         : 0;
            break;
        }
        case 123: /* sched_getaffinity: katybug runs one thread, on one CPU */
        {
            uint64_t n = a[1] < 8 ? a[1] : 8;
            if (n < 8) {
                v = -22;
                break;
            }
            kb_store(cpu, a[2], 1, 8);
            v = 8;
            break;
        }
        case 124: v = 0; break;
        case 153: {
            struct tms t;
            clock_t now = times(&t);
            long hz = sysconf(_SC_CLK_TCK);
            if (a[0]) {
                kb_store(
                    cpu, a[0], (uint64_t) t.tms_utime * 100 / (uint64_t) hz, 8
                );
                kb_store(
                    cpu, a[0] + 8, (uint64_t) t.tms_stime * 100 / (uint64_t) hz,
                    8
                );
                kb_store(
                    cpu, a[0] + 16,
                    (uint64_t) t.tms_cutime * 100 / (uint64_t) hz, 8
                );
                kb_store(
                    cpu, a[0] + 24,
                    (uint64_t) t.tms_cstime * 100 / (uint64_t) hz, 8
                );
            }
            v = (int64_t) ((uint64_t) now * 100 / (uint64_t) hz);
            break;
        }
        case 158: {
            gid_t g[256];
            int n = getgroups(a[0] > 256 ? 256 : (int) a[0], g);
            if (n < 0) {
                v = kb_err(errno);
                break;
            }
            for (int i = 0; a[0] && i < n; i++)
                kb_store(cpu, a[1] + 4 * (uint64_t) i, g[i], 4);
            v = n;
            break;
        }
        case 163: v = rlimit(cpu, (int) a[0], 0, a[1]); break;
        case 164: v = rlimit(cpu, (int) a[0], a[1], 0); break;
        case 261:
            v = a[0] && (int64_t) a[0] != getpid()
                    ? -1
                    : rlimit(cpu, (int) a[1], a[2], a[3]);
            break;
        case 165: {
            struct rusage ru;
            if (getrusage(
                    a[0] == (uint64_t) -1 ? RUSAGE_CHILDREN : RUSAGE_SELF, &ru
                ) < 0) {
                v = kb_err(errno);
                break;
            }
            for (uint64_t i = 0; i < 144; i += 8) kb_store(cpu, a[1] + i, 0, 8);
            kb_store(cpu, a[1], (uint64_t) ru.ru_utime.tv_sec, 8);
            kb_store(cpu, a[1] + 8, (uint64_t) ru.ru_utime.tv_usec, 8);
            kb_store(cpu, a[1] + 16, (uint64_t) ru.ru_stime.tv_sec, 8);
            kb_store(cpu, a[1] + 24, (uint64_t) ru.ru_stime.tv_usec, 8);
#if defined(__APPLE__)
            kb_store(
                cpu, a[1] + 32, (uint64_t) ru.ru_maxrss / 1024, 8
            ); /* bytes here, KiB on Linux */
#else
            kb_store(cpu, a[1] + 32, (uint64_t) ru.ru_maxrss, 8);
#endif
            kb_store(cpu, a[1] + 64, (uint64_t) ru.ru_minflt, 8);
            kb_store(cpu, a[1] + 72, (uint64_t) ru.ru_majflt, 8);
            kb_store(cpu, a[1] + 112, (uint64_t) ru.ru_nvcsw, 8);
            kb_store(cpu, a[1] + 120, (uint64_t) ru.ru_nivcsw, 8);
            v = 0;
            break;
        }
        case 167: /* prctl: the dumpable flag and the thread name */
        {
            static uint64_t dumpable = 1;
            static char name[16] = "katybug";
            if (a[0] == 3)
                v = (int64_t) dumpable;
            else if (a[0] == 4)
                v = a[1] > 1 ? -22 : (dumpable = a[1], 0);
            else if (a[0] == 15 || a[0] == 16) {
                uint8_t* p = kb_host(cpu, a[1], 16);
                if (!p) {
                    v = -14;
                    break;
                }
                if (a[0] == 15)
                    memcpy(name, p, 15), name[15] = 0;
                else
                    memcpy(p, name, 16);
                v = 0;
            }
            else
                v = -22;
            break;
        }
        case 169: {
            struct timespec ts;
            clock_gettime(CLOCK_REALTIME, &ts);
            if (a[0]) {
                kb_store(cpu, a[0], (uint64_t) ts.tv_sec, 8);
                kb_store(cpu, a[0] + 8, (uint64_t) (ts.tv_nsec / 1000), 8);
            }
            v = 0;
            break;
        }
        case -10: {
            time_t t = time(NULL);
            if (a[0]) kb_store(cpu, a[0], (uint64_t) t, 8);
            v = (int64_t) t;
            break;
        }
        case 439: {
            char* path = kb_str(cpu, a[1]);
            int f = ((a[3] & 0x200) ? AT_EACCESS : 0) |
                    ((a[3] & 0x100) ? AT_SYMLINK_NOFOLLOW : 0);
            v = path ? ret(faccessat(
                           host_dirfd((int64_t) a[0]), path, (int) a[2], f
                       ))
                     : -14;
            break;
        }
        default: v = kb_net(cpu, nr, a); break;
    }
    r[0] = (uint64_t) v;
    if (getenv("KATYBUG_STRACE"))
        fprintf(
            stderr,
            "katybug: syscall %lld (guest %llu) %#llx %#llx %#llx %#llx = "
            "%lld\n",
            (long long) nr, (unsigned long long) guest,
            (unsigned long long) a[0], (unsigned long long) a[1],
            (unsigned long long) a[2], (unsigned long long) a[3], (long long) v
        );
}
