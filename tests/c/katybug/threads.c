#define _GNU_SOURCE
#include <pthread.h>
#include <semaphore.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* pthreads through the guest's own libc: each line is the same natively and
 * under katybug */

#define N 8
#define ROUNDS 20000

static int64_t now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t) t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void* square(void* p) {
    return (void*) ((intptr_t) p * (intptr_t) p);
}

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static long locked;
static void* add_locked(void* p) {
    (void) p;
    for (int i = 0; i < ROUNDS; i++) {
        pthread_mutex_lock(&lock);
        locked++;
        pthread_mutex_unlock(&lock);
    }
    return NULL;
}

static atomic_long counted;
static long cas;
static void* add_atomic(void* p) {
    (void) p;
    for (int i = 0; i < ROUNDS; i++) {
        atomic_fetch_add(&counted, 1);
        long old = __atomic_load_n(&cas, __ATOMIC_RELAXED);
        while (!__atomic_compare_exchange_n(
            &cas, &old, old + 2, 0, __ATOMIC_SEQ_CST, __ATOMIC_RELAXED
        ));
    }
    return NULL;
}

/* a bounded queue: producers and consumers on one condvar pair */
static int queue[16], head, tail, count, done_producers;
static long consumed;
static pthread_cond_t not_full = PTHREAD_COND_INITIALIZER,
                      not_empty = PTHREAD_COND_INITIALIZER;
static void* produce(void* p) {
    for (int i = 1; i <= 1000; i++) {
        pthread_mutex_lock(&lock);
        while (count == 16) pthread_cond_wait(&not_full, &lock);
        queue[tail] = i * (int) (intptr_t) p;
        tail = (tail + 1) % 16;
        count++;
        pthread_cond_signal(&not_empty);
        pthread_mutex_unlock(&lock);
    }
    pthread_mutex_lock(&lock);
    done_producers++;
    pthread_cond_broadcast(&not_empty);
    pthread_mutex_unlock(&lock);
    return NULL;
}
static void* consume(void* p) {
    (void) p;
    for (;;) {
        pthread_mutex_lock(&lock);
        while (count == 0 && done_producers < 2)
            pthread_cond_wait(&not_empty, &lock);
        if (count == 0) {
            pthread_mutex_unlock(&lock);
            return NULL;
        }
        consumed += queue[head];
        head = (head + 1) % 16;
        count--;
        pthread_cond_signal(&not_full);
        pthread_mutex_unlock(&lock);
    }
}

static __thread int mine = 7;
static void* tls(void* p) {
    mine += (int) (intptr_t) p;
    usleep(1000);
    return (void*) (intptr_t) mine;
}

static pthread_once_t once = PTHREAD_ONCE_INIT;
static int inits;
static void init(void) {
    inits++;
}
static void* call_once(void* p) {
    (void) p;
    pthread_once(&once, init);
    return NULL;
}

static sem_t sem;
static void* post(void* p) {
    (void) p;
    usleep(2000);
    sem_post(&sem);
    return NULL;
}

static pthread_barrier_t barrier;
static atomic_int before, after_seen;
static void* at_barrier(void* p) {
    (void) p;
    atomic_fetch_add(&before, 1);
    pthread_barrier_wait(&barrier);
    if (atomic_load(&before) == N) atomic_fetch_add(&after_seen, 1);
    return NULL;
}

static int pipefd[2];
static void* write_later(void* p) {
    (void) p;
    usleep(20000);
    if (write(pipefd[1], "ping", 4) != 4) return (void*) 1;
    return NULL;
}

static void* nap(void* p) {
    usleep((useconds_t) (intptr_t) p);
    return NULL;
}

static atomic_int flag;
static void* spin(void* p) {
    (void) p;
    while (!atomic_load(&flag));
    return (void*) 42;
}

static pthread_rwlock_t rw = PTHREAD_RWLOCK_INITIALIZER;
static long shared;
static void* reader(void* p) {
    long seen = 0;
    for (int i = 0; i < 200; i++) {
        pthread_rwlock_rdlock(&rw);
        seen = shared;
        pthread_rwlock_unlock(&rw);
    }
    (void) p;
    return (void*) (intptr_t) (seen >= 0);
}
static void* writer(void* p) {
    for (int i = 0; i < 200; i++) {
        pthread_rwlock_wrlock(&rw);
        shared += (intptr_t) p;
        pthread_rwlock_unlock(&rw);
    }
    return NULL;
}

static void* leave(void* p) {
    pthread_exit((void*) ((intptr_t) p + 1));
    return NULL;
}

static atomic_int detached_ran;
static void* detached(void* p) {
    (void) p;
    atomic_fetch_add(&detached_ran, 1);
    return NULL;
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    pthread_t t[N];
    void* r;

    long sum = 0;
    for (intptr_t i = 0; i < N; i++)
        pthread_create(&t[i], NULL, square, (void*) i);
    for (int i = 0; i < N; i++) pthread_join(t[i], &r), sum += (intptr_t) r;
    printf("join squares %ld\n", sum);

    for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, add_locked, NULL);
    for (int i = 0; i < N; i++) pthread_join(t[i], NULL);
    printf("mutex counter %ld\n", locked);

    for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, add_atomic, NULL);
    for (int i = 0; i < N; i++) pthread_join(t[i], NULL);
    printf("atomic counter %ld cas %ld\n", (long) atomic_load(&counted), cas);

    pthread_t pc[4];
    pthread_create(&pc[0], NULL, produce, (void*) 1);
    pthread_create(&pc[1], NULL, produce, (void*) 3);
    pthread_create(&pc[2], NULL, consume, NULL);
    pthread_create(&pc[3], NULL, consume, NULL);
    for (int i = 0; i < 4; i++) pthread_join(pc[i], NULL);
    printf("queue consumed %ld\n", consumed);

    long tsum = 0;
    for (intptr_t i = 0; i < 4; i++)
        pthread_create(&t[i], NULL, tls, (void*) i);
    for (int i = 0; i < 4; i++) pthread_join(t[i], &r), tsum += (intptr_t) r;
    printf("tls %ld main %d\n", tsum, mine);

    for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, call_once, NULL);
    for (int i = 0; i < N; i++) pthread_join(t[i], NULL);
    printf("once %d\n", inits);

    sem_init(&sem, 0, 0);
    pthread_create(&t[0], NULL, post, NULL);
    sem_wait(&sem);
    pthread_join(t[0], NULL);
    printf("semaphore posted\n");

    pthread_barrier_init(&barrier, NULL, N);
    for (int i = 0; i < N; i++) pthread_create(&t[i], NULL, at_barrier, NULL);
    for (int i = 0; i < N; i++) pthread_join(t[i], NULL);
    printf("barrier %d of %d saw all\n", atomic_load(&after_seen), N);

    if (pipe(pipefd)) return 1;
    pthread_create(&t[0], NULL, write_later, NULL);
    char buf[8] = {0};
    ssize_t got = read(pipefd[0], buf, sizeof buf - 1);
    pthread_join(t[0], &r);
    printf("pipe read %zd %s %ld\n", got, buf, (long) (intptr_t) r);

    int64_t t0 = now_ms();
    for (int i = 0; i < 4; i++)
        pthread_create(&t[i], NULL, nap, (void*) (intptr_t) 200000);
    for (int i = 0; i < 4; i++) pthread_join(t[i], NULL);
    printf("sleeps overlap %d\n", now_ms() - t0 < 700);

    pthread_create(&t[0], NULL, spin, NULL);
    usleep(10000);
    atomic_store(&flag, 1);
    pthread_join(t[0], &r);
    printf("spin %ld\n", (long) (intptr_t) r);

    pthread_create(&t[0], NULL, writer, (void*) 3);
    pthread_create(&t[1], NULL, reader, NULL);
    pthread_create(&t[2], NULL, writer, (void*) 5);
    long ok = 0;
    for (int i = 0; i < 3; i++)
        pthread_join(t[i], &r), ok += i == 1 ? (intptr_t) r : 0;
    printf("rwlock %ld reader %ld\n", shared, ok);

    pthread_create(&t[0], NULL, leave, (void*) 41);
    pthread_join(t[0], &r);
    printf("pthread_exit %ld\n", (long) (intptr_t) r);

    pthread_attr_t at;
    pthread_attr_init(&at);
    pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
    for (int i = 0; i < 4; i++) pthread_create(&t[i], &at, detached, NULL);
    while (atomic_load(&detached_ran) < 4) usleep(1000);
    printf("detached %d\n", atomic_load(&detached_ran));

    printf("self differs %d\n", !pthread_equal(pthread_self(), t[0]));
    return 0;
}
