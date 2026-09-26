#include <pthread.h>
#include <stdio.h>
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t c = PTHREAD_COND_INITIALIZER;
static int count, ready;
static void* work(void* arg) {
    for (int i = 0; i < 10000; i++) {
        pthread_mutex_lock(&m);
        count++;
        pthread_mutex_unlock(&m);
    }
    pthread_mutex_lock(&m);
    ready++;
    pthread_cond_signal(&c);
    pthread_mutex_unlock(&m);
    return arg;
}
int main(void) {
    pthread_t t[4];
    for (int i = 0; i < 4; i++) pthread_create(&t[i], 0, work, 0);
    pthread_mutex_lock(&m);
    while (ready < 4) pthread_cond_wait(&c, &m);
    pthread_mutex_unlock(&m);
    for (int i = 0; i < 4; i++) pthread_join(t[i], 0);
    printf("threads count %d\n", count);
    return count == 40000 ? 0 : 1;
}
