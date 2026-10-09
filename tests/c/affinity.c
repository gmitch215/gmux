#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)
#define IRQ_CPU 1

static void* thread_set(void* arg) {
    cpu_set_t one;
    CPU_ZERO(&one);
    CPU_SET(0, &one);
    *(int*) arg = pthread_setaffinity_np(pthread_self(), sizeof one, &one);
    return arg;
}

int main(void) {
    cpu_set_t before, many, after;
    CPU_ZERO(&before);
    CPU_ZERO(&many);
    for (int cpu = 0; cpu < 8; cpu++) CPU_SET(cpu, &many);

    CHECK(
        "sched_getaffinity answers",
        !sched_getaffinity(0, sizeof before, &before)
    );
    printf("allowed cpus %d\n", CPU_COUNT(&before));
    CHECK("a task is allowed a cpu", CPU_COUNT(&before) > 0);
    CHECK("the interrupt cpu is not allowed", !CPU_ISSET(IRQ_CPU, &before));

    /* a thread keeps the flag its clone set; exec clears it for the leader */
    int thread_rc = 0;
    pthread_t t;
    pthread_create(&t, 0, thread_set, &thread_rc);
    pthread_join(t, 0);
    CHECK("a thread's pthread_setaffinity_np is EINVAL", thread_rc == EINVAL);

    /* a mask of several cpus, then exit: release_thread once hit a BUG_ON */
    CHECK(
        "a program may set a mask of several cpus",
        !sched_setaffinity(0, sizeof many, &many)
    );
    CPU_ZERO(&after);
    sched_getaffinity(0, sizeof after, &after);
    printf(
        "after: %d cpus, interrupt cpu %s\n", CPU_COUNT(&after),
        CPU_ISSET(IRQ_CPU, &after) ? "allowed" : "not allowed"
    );
    return 0;
}
