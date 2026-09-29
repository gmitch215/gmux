#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include "kb.h"

static int64_t ret(int64_t v) {
    return v < 0 ? kb_err(errno) : v;
}

/* a Linux sockaddr (family first as a u16) as the host's; 0, or a negative
 * errno */
static int64_t addr_in(
    struct kb_cpu* cpu, uint64_t va, uint64_t len, struct sockaddr_storage* ss,
    socklen_t* hl
) {
    uint8_t* p = kb_buf(cpu, va, len);
    if (!p || len < 2 || len > sizeof *ss) return -14;
    memset(ss, 0, sizeof *ss);
    uint16_t fam;
    memcpy(&fam, p, 2);
    if (fam == 1) {
        struct sockaddr_un* u = (struct sockaddr_un*) ss;
        u->sun_family = AF_UNIX;
        size_t n = len - 2 < sizeof u->sun_path ? len - 2 : sizeof u->sun_path;
        memcpy(u->sun_path, p + 2, n);
        *hl = (socklen_t) (offsetof(struct sockaddr_un, sun_path) + n);
    }
    else if (fam == 2 && len >= 16) {
        struct sockaddr_in* i = (struct sockaddr_in*) ss;
        i->sin_family = AF_INET;
        memcpy(&i->sin_port, p + 2, 2);
        memcpy(&i->sin_addr, p + 4, 4);
        *hl = sizeof *i;
    }
    else if (fam == 10 && len >= 28) {
        struct sockaddr_in6* i = (struct sockaddr_in6*) ss;
        i->sin6_family = AF_INET6;
        memcpy(&i->sin6_port, p + 2, 2);
        memcpy(&i->sin6_flowinfo, p + 4, 4);
        memcpy(&i->sin6_addr, p + 8, 16);
        memcpy(&i->sin6_scope_id, p + 24, 4);
        *hl = sizeof *i;
    }
    else
        return fam == 1 || fam == 2 || fam == 10 ? -22 : -97;
#if defined(__APPLE__)
    ss->ss_len = (uint8_t) *hl;
#endif
    return 0;
}

/* the host's sockaddr into a guest buffer whose length is at lenp
 * (value-result, truncating) */
static int64_t addr_out(
    struct kb_cpu* cpu, uint64_t va, uint64_t lenp,
    const struct sockaddr_storage* ss, socklen_t hl
) {
    if (!va || !lenp) return 0;
    uint8_t out[128] = {0};
    uint64_t n = 0;
    if (ss->ss_family == AF_UNIX) {
        const struct sockaddr_un* u = (const struct sockaddr_un*) ss;
        uint16_t fam = 1;
        memcpy(out, &fam, 2);
        size_t path = hl > offsetof(struct sockaddr_un, sun_path)
                          ? hl - offsetof(struct sockaddr_un, sun_path)
                          : 0;
        if (path > sizeof u->sun_path) path = sizeof u->sun_path;
        memcpy(out + 2, u->sun_path, path);
        n = 2 + path;
    }
    else if (ss->ss_family == AF_INET) {
        const struct sockaddr_in* i = (const struct sockaddr_in*) ss;
        uint16_t fam = 2;
        memcpy(out, &fam, 2);
        memcpy(out + 2, &i->sin_port, 2);
        memcpy(out + 4, &i->sin_addr, 4);
        n = 16;
    }
    else if (ss->ss_family == AF_INET6) {
        const struct sockaddr_in6* i = (const struct sockaddr_in6*) ss;
        uint16_t fam = 10;
        memcpy(out, &fam, 2);
        memcpy(out + 2, &i->sin6_port, 2);
        memcpy(out + 4, &i->sin6_flowinfo, 4);
        memcpy(out + 8, &i->sin6_addr, 16);
        memcpy(out + 24, &i->sin6_scope_id, 4);
        n = 28;
    }
    uint64_t room = kb_load(cpu, lenp, 4);
    uint8_t* p = kb_buf(cpu, va, room < n ? room : n);
    if (!p && room && n) return -14;
    memcpy(p, out, room < n ? room : n);
    kb_store(cpu, lenp, n, 4);
    return 0;
}

/* SOCK_NONBLOCK and SOCK_CLOEXEC ride on the type (accept4: on flags) */
static int64_t sock_flags(int fd, uint64_t f) {
    if (fd < 0) return kb_err(errno);
    if (f & 04000) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    if (f & 02000000) fcntl(fd, F_SETFD, FD_CLOEXEC);
#if defined(__APPLE__)
    int on = 1; /* EPIPE comes back as the guest's SIGPIPE, raised by katybug */
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on);
#endif
    return fd;
}

static int host_domain(uint64_t d) {
    return d == 1 ? AF_UNIX : d == 2 ? AF_INET : d == 10 ? AF_INET6 : -1;
}

static int host_msg(uint64_t f) {
    int h = 0;
    if (f & 1) h |= MSG_OOB;
    if (f & 2) h |= MSG_PEEK;
    if (f & 4) h |= MSG_DONTROUTE;
    if (f & 0x40) h |= MSG_DONTWAIT;
    if (f & 0x100) h |= MSG_WAITALL;
    return h;
}

/* a send that hit a closed peer: SIGPIPE unless the guest passed MSG_NOSIGNAL
 */
static int64_t sent(struct kb_cpu* cpu, ssize_t n, uint64_t flags) {
    if (n < 0 && errno == EPIPE && !(flags & 0x4000)) kb_raise(cpu, 13, 0);
    return ret(n);
}

/* a send on a byte stream that a batch of pieces did not cover goes on with the
 * rest, as a blocking send does; a datagram is one send */
static int is_stream(int fd) {
    int t;
    socklen_t l = sizeof t;
    return getsockopt(fd, SOL_SOCKET, SO_TYPE, &t, &l) == 0 && t == SOCK_STREAM;
}

/* the socket options katybug maps, Linux (level, name) to the host's; 0 when
 * unknown */
static int sockopt(uint64_t level, uint64_t name, int* hl, int* hn) {
    static const int sol[][2] = {{2, SO_REUSEADDR},  {3, SO_TYPE},
                                 {4, SO_ERROR},      {6, SO_BROADCAST},
                                 {7, SO_SNDBUF},     {8, SO_RCVBUF},
                                 {9, SO_KEEPALIVE},  {13, SO_LINGER},
                                 {15, SO_REUSEPORT}, {20, SO_RCVTIMEO},
                                 {21, SO_SNDTIMEO}};
    if (level == 1) {
        for (size_t i = 0; i < sizeof sol / sizeof *sol; i++)
            if ((uint64_t) sol[i][0] == name) {
                *hl = SOL_SOCKET;
                *hn = sol[i][1];
                return 1;
            }
        return 0;
    }
    if (level == 6 && name == 1) return *hl = IPPROTO_TCP, *hn = TCP_NODELAY, 1;
    if (level == 41 && name == 26)
        return *hl = IPPROTO_IPV6, *hn = IPV6_V6ONLY, 1;
    return 0;
}

static short host_events(uint64_t e) {
    short h = (short) (e & (POLLIN | POLLPRI | POLLOUT | POLLERR | POLLHUP |
                            POLLNVAL));
    if (e & 0x40) h |= POLLRDNORM;
    if (e & 0x80) h |= POLLRDBAND;
    if (e & 0x100) h |= POLLWRNORM;
    if (e & 0x200) h |= POLLWRBAND;
    return h;
}

static uint64_t guest_events(short h) {
    uint64_t e = (uint64_t) (h & (POLLIN | POLLPRI | POLLOUT | POLLERR |
                                  POLLHUP | POLLNVAL));
    if (h & POLLRDNORM) e |= 0x40;
    if (h & POLLRDBAND) e |= 0x80;
    if (h & POLLWRNORM) e |= 0x100;
    if (h & POLLWRBAND) e |= 0x200;
    return e;
}

static int64_t do_poll(
    struct kb_cpu* cpu, uint64_t fds, uint64_t n, int timeout_ms
) {
    if (n > 4096) return -22;
    struct pollfd* h = calloc(n ? n : 1, sizeof *h);
    for (uint64_t i = 0; i < n; i++) {
        h[i].fd = (int) kb_load(cpu, fds + 8 * i, 4);
        h[i].events = host_events(kb_load(cpu, fds + 8 * i + 4, 2));
    }
    int got = poll(h, (nfds_t) n, timeout_ms);
    if (got >= 0)
        for (uint64_t i = 0; i < n; i++)
            kb_store(cpu, fds + 8 * i + 6, guest_events(h[i].revents), 2);
    free(h);
    return ret(got);
}

static int64_t do_select(
    struct kb_cpu* cpu, uint64_t n, const uint64_t* sets, int64_t timeout_us
) {
    if (n > FD_SETSIZE) return -22;
    fd_set fs[3];
    uint64_t words = (n + 63) / 64;
    for (int k = 0; k < 3; k++) {
        FD_ZERO(&fs[k]);
        for (uint64_t w = 0; sets[k] && w < words; w++) {
            uint64_t bits = kb_load(cpu, sets[k] + 8 * w, 8);
            for (int b = 0; b < 64; b++)
                if (bits >> b & 1)
                    FD_SET((int) (64 * w + (uint64_t) b), &fs[k]);
        }
    }
    struct timeval tv = {
        (time_t) (timeout_us / 1000000), (suseconds_t) (timeout_us % 1000000)
    };
    int got = select(
        (int) n, sets[0] ? &fs[0] : NULL, sets[1] ? &fs[1] : NULL,
        sets[2] ? &fs[2] : NULL, timeout_us < 0 ? NULL : &tv
    );
    if (got < 0) return kb_err(errno);
    for (int k = 0; k < 3; k++)
        for (uint64_t w = 0; sets[k] && w < words; w++) {
            uint64_t bits = 0;
            for (int b = 0; b < 64; b++)
                if (64 * w + (uint64_t) b < n &&
                    FD_ISSET((int) (64 * w + (uint64_t) b), &fs[k]))
                    bits |= 1ull << b;
            kb_store(cpu, sets[k] + 8 * w, bits, 8);
        }
    return got;
}

/* sendmsg/recvmsg without ancillary data: the iovecs through one host buffer */
static int64_t msg(
    struct kb_cpu* cpu, int fd, uint64_t m, uint64_t flags, int send
) {
    uint64_t name = kb_load(cpu, m, 8), namelen = kb_load(cpu, m + 8, 4);
    uint64_t iov = kb_load(cpu, m + 16, 8), iovlen = kb_load(cpu, m + 24, 8);
    if (send && kb_load(cpu, m + 40, 8)) return -95;
    if (iovlen > 1024) return -22;
    struct iovec* h = NULL;
    int nh = 0;
    for (uint64_t i = 0; i < iovlen; i++) {
        uint64_t base = kb_load(cpu, iov + 16 * i, 8),
                 len = kb_load(cpu, iov + 16 * i + 8, 8);
        int room = (int) (len >> KB_PIECE_BITS) + 2;
        struct iovec* g =
            len ? realloc(h, (size_t) (nh + room) * sizeof *h) : h;
        int n = g && len ? kb_iov(cpu, base, len, g + nh, room) : 0;
        if (!g && len) n = -1;
        if (g) h = g;
        if (n < 0) {
            free(h);
            return -14;
        }
        nh += n;
    }
    struct sockaddr_storage ss;
    struct msghdr hm;
    memset(&hm, 0, sizeof hm);
    int64_t v;
    if (send) {
        socklen_t hl = 0;
        if (name && (v = addr_in(cpu, name, namelen, &ss, &hl)) < 0) {
            free(h);
            return v;
        }
        hm.msg_name = name ? &ss : NULL;
        hm.msg_namelen = hl;
        int stream = !name && is_stream(fd);
        int64_t total = 0;
        for (int at = 0;;) {
            int cnt = nh - at > 1024 ? 1024 : nh - at;
            uint64_t chunk = 0;
            for (int i = 0; i < cnt; i++) chunk += h[at + i].iov_len;
            hm.msg_iov = h + at;
            hm.msg_iovlen = cnt;
            v = sent(cpu, sendmsg(fd, &hm, host_msg(flags)), flags);
            if (v < 0) {
                if (total) v = total;
                break;
            }
            total += v;
            at += cnt;
            if (!stream || (uint64_t) v < chunk || at >= nh) {
                v = total;
                break;
            }
        }
    }
    else {
        hm.msg_iov = h;
        hm.msg_iovlen = nh > 1024 ? 1024 : nh;
        hm.msg_name = &ss;
        hm.msg_namelen = sizeof ss;
        v = ret(recvmsg(fd, &hm, host_msg(flags)));
        if (v >= 0) {
            if (name && hm.msg_namelen)
                addr_out(cpu, name, m + 8, &ss, hm.msg_namelen);
            else
                kb_store(cpu, m + 8, 0, 4);
            kb_store(cpu, m + 40, 0, 8); /* msg_controllen: no ancillary data */
            kb_store(cpu, m + 48, 0, 4);
        }
    }
    free(h);
    return v;
}

int64_t kb_net(struct kb_cpu* cpu, int64_t nr, const uint64_t* a) {
    struct sockaddr_storage ss;
    socklen_t hl = sizeof ss;
    int64_t v;
    int fd = (int) a[0];
    switch (nr) {
        case 198: {
            int d = host_domain(a[0]);
            if (d < 0) return -97;
            return sock_flags(socket(d, (int) (a[1] & 0xf), (int) a[2]), a[1]);
        }
        case 199: {
            int d = host_domain(a[0]), sv[2];
            if (d < 0) return -97;
            if (socketpair(d, (int) (a[1] & 0xf), (int) a[2], sv) < 0)
                return kb_err(errno);
            sock_flags(sv[0], a[1]);
            sock_flags(sv[1], a[1]);
            kb_store(cpu, a[3], (uint64_t) (uint32_t) sv[0], 4);
            kb_store(cpu, a[3] + 4, (uint64_t) (uint32_t) sv[1], 4);
            return 0;
        }
        case 200:
        case 203:
            if ((v = addr_in(cpu, a[1], a[2], &ss, &hl)) < 0) return v;
            return ret(
                nr == 200 ? bind(fd, (struct sockaddr*) &ss, hl)
                          : connect(fd, (struct sockaddr*) &ss, hl)
            );
        case 201: return ret(listen(fd, (int) a[1]));
        case 202:
        case 242: {
            int c = accept(fd, (struct sockaddr*) &ss, &hl);
            if (c < 0) return kb_err(errno);
            addr_out(cpu, a[1], a[2], &ss, hl);
            return sock_flags(c, nr == 242 ? a[3] : 0);
        }
        case 204:
        case 205:
            if ((nr == 204 ? getsockname(fd, (struct sockaddr*) &ss, &hl)
                           : getpeername(fd, (struct sockaddr*) &ss, &hl)) < 0)
                return kb_err(errno);
            return addr_out(cpu, a[1], a[2], &ss, hl);
        case 206: {
            if (a[4] && (v = addr_in(cpu, a[4], a[5], &ss, &hl)) < 0) return v;
            int stream = !a[4] && is_stream(fd);
            uint64_t va = a[1], len = a[2];
            int64_t total = 0;
            for (;;) {
                struct iovec iov[256];
                int n = len ? kb_iov(cpu, va, len, iov, 256) : 0;
                if (n < 0) return -14;
                uint64_t chunk = 0;
                for (int i = 0; i < n; i++) chunk += iov[i].iov_len;
                void* p = n ? iov[0].iov_base : NULL;
                size_t k = n ? iov[0].iov_len : 0;
                if (n > 1) {
                    struct msghdr hm;
                    memset(&hm, 0, sizeof hm);
                    hm.msg_name = a[4] ? &ss : NULL;
                    hm.msg_namelen = a[4] ? hl : 0;
                    hm.msg_iov = iov;
                    hm.msg_iovlen = n;
                    v = sent(cpu, sendmsg(fd, &hm, host_msg(a[3])), a[3]);
                }
                else if (a[4])
                    v = sent(
                        cpu,
                        sendto(
                            fd, p, k, host_msg(a[3]), (struct sockaddr*) &ss, hl
                        ),
                        a[3]
                    );
                else
                    v = sent(cpu, send(fd, p, k, host_msg(a[3])), a[3]);
                if (v < 0) return total ? total : v;
                total += v;
                if (!stream || (uint64_t) v < chunk || chunk >= len)
                    return total;
                va += chunk, len -= chunk;
            }
        }
        case 207: {
            struct iovec iov[256];
            int cnt = a[2] ? kb_iov(cpu, a[1], a[2], iov, 256) : 0;
            if (cnt < 0) return -14;
            ssize_t n;
            if (cnt > 1) {
                struct msghdr hm;
                memset(&hm, 0, sizeof hm);
                hm.msg_name = &ss;
                hm.msg_namelen = sizeof ss;
                hm.msg_iov = iov;
                hm.msg_iovlen = cnt;
                n = recvmsg(fd, &hm, host_msg(a[3]));
                hl = hm.msg_namelen;
            }
            else
                n = recvfrom(
                    fd, cnt ? iov[0].iov_base : NULL, cnt ? iov[0].iov_len : 0,
                    host_msg(a[3]), (struct sockaddr*) &ss, &hl
                );
            if (n < 0) return kb_err(errno);
            if (a[4]) addr_out(cpu, a[4], a[5], &ss, hl);
            return n;
        }
        case 208:
        case 209: {
            int level, name;
            if (!sockopt(a[1], a[2], &level, &name)) return -92;
            /* option values pass as they are: ints, and timeval/linger lay out
             * alike on 64-bit hosts */
            if (nr == 208) {
                uint8_t* p = kb_buf(cpu, a[3], a[4]);
                if (!p && a[4]) return -14;
                return ret(setsockopt(fd, level, name, p, (socklen_t) a[4]));
            }
            socklen_t len = (socklen_t) kb_load(cpu, a[4], 4);
            uint8_t buf[64] = {0};
            if (len > sizeof buf) len = sizeof buf;
            if (getsockopt(fd, level, name, buf, &len) < 0)
                return kb_err(errno);
            if (name == SO_ERROR && len == 4) {
                int e;
                memcpy(&e, buf, 4);
                e = e ? (int) -kb_err(e) : 0;
                memcpy(buf, &e, 4);
            }
            if (name == SO_TYPE && len == 4) {
                int t;
                memcpy(&t, buf, 4);
                t = t == SOCK_STREAM      ? 1
                    : t == SOCK_DGRAM     ? 2
                    : t == SOCK_SEQPACKET ? 5
                    : t == SOCK_RAW       ? 3
                                          : t;
                memcpy(buf, &t, 4);
            }
            uint8_t* p = kb_buf(cpu, a[3], len);
            if (!p && len) return -14;
            memcpy(p, buf, len);
            kb_store(cpu, a[4], len, 4);
            return 0;
        }
        case 210: return ret(shutdown(fd, (int) a[1]));
        case 211:
        case 212: return msg(cpu, fd, a[1], a[2], nr == 211);
        case -7:
            return do_poll(cpu, a[0], a[1], (int) a[2]); /* poll(fds, n, ms) */
        /* ponytail: ppoll/pselect6 ignore their signal mask; apply it if a
         * guest relies on it */
        case 73: /* ppoll(fds, n, timespec, sigmask) */
        {
            int ms = -1;
            if (a[2])
                ms = (int) (kb_load(cpu, a[2], 8) * 1000 +
                            (kb_load(cpu, a[2] + 8, 8) + 999999) / 1000000);
            return do_poll(cpu, a[0], a[1], ms);
        }
        case -8: /* select(n, r, w, e, timeval) */
        {
            int64_t us = a[4] ? (int64_t) (kb_load(cpu, a[4], 8) * 1000000 +
                                           kb_load(cpu, a[4] + 8, 8))
                              : -1;
            struct timespec t0, t1;
            clock_gettime(CLOCK_MONOTONIC, &t0);
            v = do_select(cpu, a[0], a + 1, us);
            if (a[4] && v >= 0) /* Linux leaves the time not slept */
            {
                clock_gettime(CLOCK_MONOTONIC, &t1);
                int64_t left =
                    us - ((int64_t) (t1.tv_sec - t0.tv_sec) * 1000000 +
                          (t1.tv_nsec - t0.tv_nsec) / 1000);
                if (left < 0) left = 0;
                kb_store(cpu, a[4], (uint64_t) (left / 1000000), 8);
                kb_store(cpu, a[4] + 8, (uint64_t) (left % 1000000), 8);
            }
            return v;
        }
        case 72: /* pselect6(n, r, w, e, timespec, sigmask) */
        {
            int64_t us =
                a[4] ? (int64_t) (kb_load(cpu, a[4], 8) * 1000000 +
                                  (kb_load(cpu, a[4] + 8, 8) + 999) / 1000)
                     : -1;
            return do_select(cpu, a[0], a + 1, us);
        }
    }
    return -38;
}
