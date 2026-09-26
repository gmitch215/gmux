#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static long long ns(clockid_t id) {
    struct timespec t;
    clock_gettime(id, &t);
    return t.tv_sec * 1000000000LL + t.tv_nsec;
}

int main(void) {
    /* a read costs what a read costs: never backwards, and not a millisecond
     * clock stepping */
    long long a = ns(CLOCK_MONOTONIC), b = ns(CLOCK_MONOTONIC);
    CHECK("back-to-back reads are under 1 us apart", b >= a && b - a < 1000);
    printf("read-to-read %lld ns\n", b - a);

    long long before = ns(CLOCK_MONOTONIC), cpu = ns(CLOCK_PROCESS_CPUTIME_ID);
    struct timespec ten = {0, 10000000};
    nanosleep(&ten, 0);
    long long slept = ns(CLOCK_MONOTONIC) - before,
              cpuSlept = ns(CLOCK_PROCESS_CPUTIME_ID) - cpu;
    CHECK(
        "a 10 ms sleep measures 10-50 ms", slept >= 10000000 && slept < 50000000
    );
    CHECK("sleeping uses under 1 ms of CPU time", cpuSlept < 1000000);
    printf("slept %lld ns, cpu %lld ns\n", slept, cpuSlept);

    /* a busy wait on the clock ends, as work takes time */
    long long start = ns(CLOCK_MONOTONIC), spins = 0;
    while (ns(CLOCK_MONOTONIC) - start < 5000000 && spins < 100000000) spins++;
    CHECK("a 5 ms busy wait ends", spins < 100000000);
    printf("busy wait %lld spins\n", spins);

    char x[] = "/tmp/time-XXXXXX", y[] = "/tmp/time-XXXXXX";
    int fx = mkstemp(x), fy = mkstemp(y);
    CHECK("mkstemp twice at once", fx >= 0 && fy >= 0 && strcmp(x, y));
    unlink(x), unlink(y);

    printf("EPOCH %lld\n", (long long) time(0));
    return 0;
}
