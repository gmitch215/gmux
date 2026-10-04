#define ROUTE_KERNEL 1
#define ROUTE_HOOK 2
#define ROUTE_WRITES 3
#define SYS_OPENAT 56
#define SYS_STATX 291
#define O_DSYNC 010000
#define MISS 1

#define IMPORT(module, name)                                                   \
    __attribute__((import_module(module), import_name(name)))
#define EXPORT(name) __attribute__((export_name(name)))
#define GLOBAL extern __attribute__((address_space(1)))

GLOBAL int route;
// not const: clang 23 imports const as immutable, clang 18 as mutable
GLOBAL int cache;

IMPORT("k", "0") int k0(int, int, int);
IMPORT("k", "1") int k1(int, int, int, int);
IMPORT("k", "2") int k2(int, int, int, int, int);
IMPORT("k", "3") int k3(int, int, int, int, int, int);
IMPORT("k", "4") int k4(int, int, int, int, int, int, int);
IMPORT("k", "5") int k5(int, int, int, int, int, int, int, int);
IMPORT("k", "6") int k6(int, int, int, int, int, int, int, int, int);
IMPORT("h", "0") int h0(int, int, int);
IMPORT("h", "1") int h1(int, int, int, int);
IMPORT("h", "2") int h2(int, int, int, int, int);
IMPORT("h", "3") int h3(int, int, int, int, int, int);
IMPORT("h", "4") int h4(int, int, int, int, int, int, int);
IMPORT("h", "5") int h5(int, int, int, int, int, int, int, int);
IMPORT("h", "6") int h6(int, int, int, int, int, int, int, int, int);
IMPORT("c", "5") int c5(int, int, int, int, int, int, int, int);

// the hook suspends, so its result comes back here and never by a tail call
#define KEEP(call)                                                             \
    ({                                                                         \
        int kept = (call);                                                     \
        __asm__ volatile("" : "+r"(kept));                                     \
        kept;                                                                  \
    })

// the same lists as SYNC_CALLS and WRITE_CALLS in router.ts
static int is_sync(int nr) {
    switch (nr) {
        case 81:
        case 82:
        case 83:
        case 84:
        case 227:
        case 267:
        case 287: return 1;
    }
    return 0;
}

static int is_write(int nr) {
    switch (nr) {
        case 64:
        case 66:
        case 68:
        case 70:
        case 71:
        case 76:
        case 285: return 1;
    }
    return 0;
}

// openat's flags are its third argument
static int to_hook(int nr, int flags) {
    return route == ROUTE_HOOK || is_sync(nr) ||
           (nr == SYS_OPENAT && (flags & O_DSYNC)) ||
           (route == ROUTE_WRITES && is_write(nr));
}

EXPORT("s0") int s0(int sp, int tls, int nr) {
    if (route != ROUTE_KERNEL && to_hook(nr, 0)) return KEEP(h0(sp, tls, nr));
    __attribute__((musttail)) return k0(sp, tls, nr);
}

EXPORT("s1") int s1(int sp, int tls, int nr, int a) {
    if (route != ROUTE_KERNEL && to_hook(nr, 0))
        return KEEP(h1(sp, tls, nr, a));
    __attribute__((musttail)) return k1(sp, tls, nr, a);
}

EXPORT("s2") int s2(int sp, int tls, int nr, int a, int b) {
    if (route != ROUTE_KERNEL && to_hook(nr, 0))
        return KEEP(h2(sp, tls, nr, a, b));
    __attribute__((musttail)) return k2(sp, tls, nr, a, b);
}

EXPORT("s3") int s3(int sp, int tls, int nr, int a, int b, int c) {
    if (route != ROUTE_KERNEL && to_hook(nr, c))
        return KEEP(h3(sp, tls, nr, a, b, c));
    __attribute__((musttail)) return k3(sp, tls, nr, a, b, c);
}

EXPORT("s4") int s4(int sp, int tls, int nr, int a, int b, int c, int d) {
    if (route != ROUTE_KERNEL && to_hook(nr, c))
        return KEEP(h4(sp, tls, nr, a, b, c, d));
    __attribute__((musttail)) return k4(sp, tls, nr, a, b, c, d);
}

EXPORT("s5")
int s5(int sp, int tls, int nr, int a, int b, int c, int d, int e) {
    if (route == ROUTE_KERNEL) __attribute__
        ((musttail)) return k5(sp, tls, nr, a, b, c, d, e);
    // a hit answers alone; a miss goes to the hook, which fills the cache
    if (cache && nr == SYS_STATX && route != ROUTE_HOOK) {
        int answer = KEEP(c5(sp, tls, nr, a, b, c, d, e));
        if (answer != MISS) return answer;
        return KEEP(h5(sp, tls, nr, a, b, c, d, e));
    }
    if (to_hook(nr, c)) return KEEP(h5(sp, tls, nr, a, b, c, d, e));
    __attribute__((musttail)) return k5(sp, tls, nr, a, b, c, d, e);
}

EXPORT("s6")
int s6(int sp, int tls, int nr, int a, int b, int c, int d, int e, int f) {
    if (route != ROUTE_KERNEL && to_hook(nr, c))
        return KEEP(h6(sp, tls, nr, a, b, c, d, e, f));
    __attribute__((musttail)) return k6(sp, tls, nr, a, b, c, d, e, f);
}
