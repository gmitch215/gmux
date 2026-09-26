/* the native reference: the same kernels, timed with a monotonic clock */
#include <stdio.h>
#include <time.h>
void init(void);
float sgemm(int);
int dot8(int);
float conv3(int);
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
int main(void) {
    init();
    sgemm(1), dot8(1), conv3(1);
    double t = now();
    volatile float a = sgemm(40);
    double s = now() - t;
    printf(
        "{\"kernel\":\"sgemm\",\"gops\":%.2f}\n",
        2.0 * 256 * 256 * 256 * 40 / s / 1e9
    );
    t = now();
    volatile int b = dot8(20);
    s = now() - t;
    printf(
        "{\"kernel\":\"dot8\",\"gops\":%.2f}\n", 2.0 * (1 << 24) * 20 / s / 1e9
    );
    t = now();
    volatile float c = conv3(40);
    s = now() - t;
    printf(
        "{\"kernel\":\"conv3\",\"gops\":%.2f}\n",
        18.0 * 512 * 512 * 40 / s / 1e9
    );
    (void) a, (void) b, (void) c;
    return 0;
}
