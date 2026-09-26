// the resume test: every shape a checkpoint can land in. tick() is the
// safepoint; out() the only output, so a resumed run is exact when its outputs
// continue the reference run's
__attribute__((import_module("env"), import_name("tick"))) void tick(void);
__attribute__((import_module("env"), import_name("out"))) void out(long long v);

struct acc {
    long long sum;
    int calls;
};

static unsigned seed = 1;

static unsigned next(void) {
    seed = seed * 1103515245u + 12345u;
    return seed >> 8;
}

__attribute__((noinline)) static long long fib(int n, struct acc* a) {
    a->calls++;
    if ((a->calls & 63) == 0) tick();
    if (n < 2) return n;
    return fib(n - 1, a) + fib(n - 2, a);
}

typedef long long (*op_fn)(long long, int);

__attribute__((noinline)) static long long op_add(long long x, int i) {
    tick();
    return x + i;
}

__attribute__((noinline)) static long long op_mix(long long x, int i) {
    for (int k = 0; k < 3; k++) {
        x = x * 31 + (i ^ k);
        if (k == 1) tick();
    }
    return x;
}

__attribute__((noinline)) static long long op_sort(long long x, int i) {
    int v[16]; // address-taken stack data lives in linear memory
    for (int k = 0; k < 16; k++) v[k] = (int) (next() % 1000);
    for (int a = 1; a < 16; a++) {
        int t = v[a], b = a - 1;
        while (b >= 0 && v[b] > t) {
            v[b + 1] = v[b];
            b--;
        }
        v[b + 1] = t;
        if ((a & 7) == 0) tick();
    }
    return x + v[i & 15];
}

op_fn ops[] = {op_add, op_mix, op_sort};

__attribute__((noinline)) static long long nested(int rounds) {
    long long x = 7;
    for (int r = 0; r < rounds; r++) {
        for (int j = 0; j < 5; j++) {
            x = ops[(r + j) % 3](x, r * 5 + j);
            if (j == 2) continue;
            if (x & 1) x ^= 0x5555;
        }
        out(x);
    }
    return x;
}

__attribute__((export_name("run"))) long long run(int n) {
    struct acc a = {0, 0};
    long long total = 0;
    for (int i = 0; i < n; i++) {
        a.sum += fib(12 + (i % 4), &a);
        out(a.sum);
        total += nested(3 + (i % 3));
    }
    out(a.calls);
    return total + a.sum;
}
