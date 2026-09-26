#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
static void on(int s) {
    struct timespec t = {0, 50000000};
    nanosleep(&t, 0);
    write(1, "handler slept\n", 14);
}
int main(void) {
    signal(SIGALRM, on);
    alarm(1);
    pause();
    puts("after pause");
    return 0;
}
