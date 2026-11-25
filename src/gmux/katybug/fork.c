#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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
   the file is only named, and the child maps it from the same descriptor.
   The stream ends with the decoded blocks that earlier children ran (see
   below), which the child takes instead of decoding again */

#define BLOCKS_MAX (256ull << 20)
#define HINTS_MAX (1u << 20)

/* the pcs a child's cache held when it exited, sent to the parent down a
   pipe that stays open in every child (nonblocking, in writes that are whole
   words, so a full pipe loses a report and a cut one cannot happen); the next
   fork sends the parent's blocks at those pcs and no others */
static int hint_r = -1, hint_w = -1, hint_out = -1;
static uint64_t* hints;
static size_t hint_cap, hint_n;
static const struct kb_cpu* reporter;
static uint8_t* packed;
static size_t packed_len;
static uint64_t packed_key[4];

static size_t hint_slot(uint64_t pc) {
    size_t i = (size_t) (pc * 0x9e3779b97f4a7c15ull >> 40) & (hint_cap - 1);
    while (hints[i] && hints[i] != pc) i = (i + 1) & (hint_cap - 1);
    return i;
}

static int hint_has(uint64_t pc) {
    return hint_cap && hints[hint_slot(pc)] == pc;
}

static void hint_add(uint64_t pc) {
    if (!pc || hint_n >= HINTS_MAX) return;
    if (2 * (hint_n + 1) > hint_cap) {
        size_t cap = hint_cap ? 2 * hint_cap : 4096;
        uint64_t* old = hints;
        size_t oldcap = hint_cap;
        hints = calloc(cap, sizeof *hints);
        if (!hints) {
            hints = old;
            return;
        }
        hint_cap = cap;
        for (size_t i = 0; i < oldcap; i++)
            if (old[i]) hints[hint_slot(old[i])] = old[i];
        free(old);
    }
    size_t i = hint_slot(pc);
    if (!hints[i]) hints[i] = pc, hint_n++;
}

/* the pipe is made once, at the first fork; a process that cannot make it
   sends no blocks */
static void hint_open(void) {
    if (hint_r != -1) return;
    hint_r = -2;
    int q[2];
    if (pipe(q) < 0) return;
    int r = kb_keep_fd(q[0]), w = kb_keep_fd(q[1]);
    close(q[0]);
    close(q[1]);
    if (r < 0 || w < 0) {
        if (r >= 0) close(r);
        if (w >= 0) close(w);
        return;
    }
    fcntl(r, F_SETFL, fcntl(r, F_GETFL) | O_NONBLOCK);
    fcntl(w, F_SETFL, fcntl(w, F_GETFL) | O_NONBLOCK);
    hint_r = r, hint_w = w;
}

static void hint_drain(void) {
    uint64_t buf[512];
    ssize_t got;
    while (hint_r >= 0 && (got = read(hint_r, buf, sizeof buf)) > 0)
        for (size_t i = 0; i < (size_t) got / sizeof *buf; i++)
            hint_add(buf[i]);
}

/* at exit, in the child */
static void hint_report(void) {
    if (hint_out < 0 || !reporter) return;
    enum
    {
        ROOM = PIPE_BUF / 8 < 512 ? PIPE_BUF / 8 : 512
    };
    uint64_t buf[ROOM];
    size_t k = 0, room = ROOM;
    for (int h = 0; h < 4096; h++)
        for (const struct kb_block* b = reporter->cache[h]; b; b = b->chain) {
            if (!b->n) continue;
            buf[k++] = b->pc;
            if (k == room) {
                if (write(hint_out, buf, sizeof buf) != (ssize_t) sizeof buf)
                    return;
                k = 0;
            }
        }
    if (k) (void) !write(hint_out, buf, k * sizeof *buf);
}

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
    hint_open();
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
    if (!bad) {
        int32_t out = hint_w;
        hint_drain();
        /* the packed table is kept while nothing it holds can have changed;
           the child checks each block's bytes again whatever the table says */
        uint64_t key[4] = {cpu->decoded, cpu->traces, cpu->codegen, hint_n};
        if (!packed_len || memcmp(key, packed_key, sizeof key)) {
            free(packed);
            packed =
                hint_n ? kb_persist_pack(cpu, &packed_len, hint_has) : NULL;
            if (!packed) packed_len = 0;
            memcpy(packed_key, key, sizeof key);
        }
        uint64_t sent = packed_len;
        bad = put(p[1], &out, sizeof out) || put(p[1], &sent, sizeof sent) ||
              (sent && put(p[1], packed, packed_len));
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
    cpu->marks = NULL;
    cpu->nmarks = cpu->capmarks = 0;
    cpu->trace = NULL;
    cpu->persist = NULL;
    cpu->decoded = cpu->loaded = 0;
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
    /* the blocks are a hint: a stream that ends here leaves the child decoding
     */
    int32_t out = -1;
    uint64_t sent;
    uint8_t* blocks = NULL;
    if (!get(fd, &out, sizeof out) && !get(fd, &sent, sizeof sent) && sent) {
        blocks = sent <= BLOCKS_MAX ? malloc(sent) : NULL;
        if (blocks && get(fd, blocks, sent)) {
            free(blocks);
            blocks = NULL;
        }
        uint8_t skip[4096];
        for (uint64_t left = blocks ? 0 : sent; left;) {
            size_t k = left < sizeof skip ? (size_t) left : sizeof skip;
            if (get(fd, skip, k)) break;
            left -= k;
        }
    }
    if (blocks) kb_persist_adopt(cpu, blocks, (size_t) sent);
    if (out >= 0 && fcntl(out, F_GETFD) >= 0) {
        hint_out = out;
        reporter = cpu;
        atexit(hint_report);
    }
    close(fd);
    for (int i = 0; i < n; i++) fcntl(cloexec[i], F_SETFD, FD_CLOEXEC);
    kb_sig_reinstall(cpu);
    cpu->r[0] = 0;
    return 0;
}
