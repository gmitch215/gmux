#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "kb.h"

extern char** environ;

/* fork without the host's fork, for hosts where it cannot copy a running wasm
   program (gmux's no-MMU kernel): vfork, exec katybug again, and send the new
   process the guest's whole state over a pipe: the cpu, the descriptors that
   must regain FD_CLOEXEC, the guest's descriptor limit, then every mapping's
   bytes in order; a piece that was never made (an image's, not yet read from
   its file) is not sent, and the child reads it from the descriptor on the
   file, which the exec keeps at its number; a piece the parent shares with
   the file is only named, and the child maps it from the same descriptor */

static int put(int fd, const void* p, size_t n) {
    const uint8_t* b = p;
    while (n) {
        ssize_t w = write(fd, b, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        b += w;
        n -= (size_t) w;
    }
    return 0;
}

static int get(int fd, void* p, size_t n) {
    uint8_t* b = p;
    while (n) {
        ssize_t r = read(fd, b, n);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) return -1;
        b += r;
        n -= (size_t) r;
    }
    return 0;
}

/** whether a guest fork goes through kb_fork: always on wasm, and on request
 * (KATYBUG_FORK=exec) */
int kb_fork_by_exec(void) {
#if defined(__wasm__)
    return 1;
#else
    const char* f = getenv("KATYBUG_FORK");
    return f && strcmp(f, "exec") == 0;
#endif
}

/** the parent's half: the child's pid, or a negative Linux errno */
int64_t kb_fork(struct kb_cpu* cpu) {
    int p[2];
    if (pipe(p) < 0) return kb_err(errno);
    fcntl(p[1], F_SETFD, FD_CLOEXEC);
    int32_t cloexec[1024], n = 0;
    for (int fd = 0; fd < 1024; fd++) {
        int f = fcntl(fd, F_GETFD);
        if (f >= 0 && (f & FD_CLOEXEC) && fd != p[0] && fd != p[1])
            cloexec[n++] = fd;
    }
    char arg[16];
    snprintf(arg, sizeof arg, "%d", p[0]);
    char* argv[] = {(char*) kb_self, "--katybug-resume", arg, NULL};
#if defined(__APPLE__)
    pid_t pid = fork(); /* vfork is deprecated there, and this path only tests
                           the transfer */
#else
    pid_t pid = vfork();
#endif
    if (pid == 0) {
        /* the child's own descriptor table: the guest expects these open after
         * fork */
        for (int i = 0; i < n; i++) fcntl(cloexec[i], F_SETFD, 0);
        execve(kb_self, argv, environ);
        _exit(127);
    }
    close(p[0]);
    if (pid < 0) {
        close(p[1]);
        return kb_err(errno);
    }
    uint64_t nofile[2];
    kb_nofile_get(nofile);
    int bad = put(p[1], cpu, sizeof *cpu) || put(p[1], &n, sizeof n) ||
              put(p[1], cloexec, sizeof *cloexec * (size_t) n) ||
              put(p[1], nofile, sizeof nofile);
    for (int i = 0; !bad && i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        uint64_t np = kb_pieces(m->start, m->end, m->bits);
        for (uint64_t k = 0; !bad && k < np; k++) {
            uint8_t here = !m->pieces[k] ? 0 : kb_shared(m->pieces[k]) ? 2 : 1;
            bad = put(p[1], &here, 1);
            if (!bad && here == 1) {
                uint64_t lo, hi;
                kb_piece_blank(m, kb_piece_va(m, k), &lo, &hi);
                bad = put(p[1], m->pieces[k], hi - lo);
            }
        }
    }
    if (!bad) {
        struct kb_digest_row rows[KB_HD_ROWS];
        int32_t nrow = kb_digest_fork(rows);
        bad = put(p[1], &nrow, sizeof nrow) ||
              put(p[1], rows, sizeof *rows * (size_t) nrow);
    }
    close(p[1]);
    /* a child that got no state exits 127 on its own; the parent still sees a
     * fork that happened */
    return pid;
}

/** the child's half, in the new katybug: the guest state from fd, resumed as
 * fork's child (0) */
int kb_resume(struct kb_cpu* cpu, int fd) {
    int32_t n;
    int32_t cloexec[1024];
    uint64_t nofile[2];
    if (get(fd, cpu, sizeof *cpu) || get(fd, &n, sizeof n) || n < 0 ||
        n > 1024 || get(fd, cloexec, sizeof *cloexec * (size_t) n) ||
        get(fd, nofile, sizeof nofile))
        return -1;
    for (int i = 0; i < cpu->nimages; i++) {
        struct stat st;
        if (fstat(cpu->images[i].fd, &st) ||
            (uint64_t) st.st_dev != cpu->images[i].dev ||
            (uint64_t) st.st_ino != cpu->images[i].ino)
            return -1; /* the file the parent read pieces from did not arrive */
    }
    for (int i = 0; i < cpu->nfiles; i++) {
        struct stat st;
        if (fstat(cpu->files[i].fd, &st) ||
            (uint64_t) st.st_dev != cpu->files[i].dev ||
            (uint64_t) st.st_ino != cpu->files[i].ino)
            return -1;
    }
    kb_nofile_set(nofile);
    memset(cpu->cache, 0, sizeof cpu->cache);
    cpu->trace = NULL;
    cpu->fault = cpu->last_fault = NULL;
    cpu->restore_mask = 0;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        uint64_t np = kb_pieces(m->start, m->end, m->bits);
        m->pieces = calloc((size_t) np, sizeof *m->pieces);
        if (!m->pieces) return -1;
        for (uint64_t k = 0; k < np; k++) {
            uint8_t here;
            if (get(fd, &here, 1)) return -1;
            if (!here) continue;
            if (here == 2) {
                if (kb_adopt(cpu, m, k)) return -1;
                continue;
            }
            uint64_t lo, hi;
            uint8_t* piece = kb_piece_blank(m, kb_piece_va(m, k), &lo, &hi);
            if (!piece || get(fd, piece, hi - lo)) return -1;
        }
    }
    int32_t nrow;
    struct kb_digest_row row;
    if (get(fd, &nrow, sizeof nrow) || nrow < 0 || nrow > KB_HD_ROWS) return -1;
    for (int i = 0; i < nrow; i++) {
        if (get(fd, &row, sizeof row)) return -1;
        kb_digest_adopt(&row);
    }
    close(fd);
    for (int i = 0; i < n; i++) fcntl(cloexec[i], F_SETFD, FD_CLOEXEC);
    kb_sig_reinstall(cpu);
    cpu->r[0] = 0;
    return 0;
}
