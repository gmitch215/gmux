#include "core.h"

/* the scheduler's decisions: which idle cpu runs next and when the next timer
 * is due. A slot names a host runner (the host keeps the objects); an idle
 * entry is one cpu waiting on its interrupt word, with an optional deadline,
 * and `order` is where the host listed the cpu, so ties go to the same cpu as
 * a walk of the host's list */

#define IDLE_MAX 256
#define READY_MAX 1024

struct idle {
    uint32_t word;
    uint32_t order;
    int32_t slot;
    int64_t deadline;
};

/* sorted by order, so a pick takes the first that is due */
static struct idle idle[IDLE_MAX];
static uint32_t idle_n;
/* the earliest deadline among the entries, or -1 when none has one */
static int64_t soonest = -1;

static int32_t ready[READY_MAX];
static uint32_t ready_head;
static uint32_t ready_n;

static void find_soonest(void) {
    soonest = -1;
    for (uint32_t i = 0; i < idle_n; i++)
        if (idle[i].deadline >= 0 &&
            (soonest < 0 || idle[i].deadline < soonest))
            soonest = idle[i].deadline;
}

static void drop(uint32_t i) {
    int64_t deadline = idle[i].deadline;
    for (uint32_t j = i + 1; j < idle_n; j++) idle[j - 1] = idle[j];
    idle_n--;
    if (deadline >= 0 && deadline == soonest) find_soonest();
}

CORE_EXPORT void core_reset(void) {
    idle_n = 0;
    soonest = -1;
    ready_head = 0;
    ready_n = 0;
}

/* arms a cpu's wait (replacing its earlier one); deadline < 0 waits on the
 * word alone. Returns 0, or -1 when the table is full */
CORE_EXPORT int core_idle(
    int32_t slot, uint32_t order, uint32_t word, int64_t deadline
) {
    for (uint32_t i = 0; i < idle_n; i++)
        if (idle[i].slot == slot) {
            drop(i);
            break;
        }
    if (idle_n == IDLE_MAX) return -1;
    uint32_t i = idle_n++;
    while (i > 0 && idle[i - 1].order > order) {
        idle[i] = idle[i - 1];
        i--;
    }
    idle[i] = (struct idle){word, order, slot, deadline};
    if (deadline >= 0 && (soonest < 0 || deadline < soonest))
        soonest = deadline;
    return 0;
}

/* disarms a cpu's wait; 1 when it had one */
CORE_EXPORT int core_cancel(int32_t slot) {
    for (uint32_t i = 0; i < idle_n; i++)
        if (idle[i].slot == slot) {
            drop(i);
            return 1;
        }
    return 0;
}

/* the first cpu, in order, whose interrupt word is raised or whose deadline
 * is at or before now; it is disarmed. -1 when none is due */
CORE_EXPORT int32_t core_pick(int64_t now) {
    int due = soonest >= 0 && soonest <= now;
    for (uint32_t i = 0; i < idle_n; i++) {
        if (CORE_WORD(idle[i].word) != 0 ||
            (due && idle[i].deadline >= 0 && idle[i].deadline <= now)) {
            int32_t slot = idle[i].slot;
            drop(i);
            return slot;
        }
    }
    return -1;
}

/* the earliest armed deadline, or -1 */
CORE_EXPORT int64_t core_deadline(void) {
    return soonest;
}

CORE_EXPORT int core_idle_count(void) {
    return (int) idle_n;
}

/* the ready queue: runners that can run now, in the order they will */
CORE_EXPORT int core_ready_push(int32_t slot) {
    if (ready_n == READY_MAX) return -1;
    ready[(ready_head + ready_n++) % READY_MAX] = slot;
    return 0;
}

CORE_EXPORT int core_ready_unshift(int32_t slot) {
    if (ready_n == READY_MAX) return -1;
    ready_head = (ready_head + READY_MAX - 1) % READY_MAX;
    ready[ready_head] = slot;
    ready_n++;
    return 0;
}

/* the next runner's slot, or -1 when none is ready */
CORE_EXPORT int32_t core_ready_shift(void) {
    if (!ready_n) return -1;
    int32_t slot = ready[ready_head];
    ready_head = (ready_head + 1) % READY_MAX;
    ready_n--;
    return slot;
}

CORE_EXPORT int core_ready_count(void) {
    return (int) ready_n;
}

CORE_EXPORT int32_t core_ready_at(uint32_t i) {
    return i < ready_n ? ready[(ready_head + i) % READY_MAX] : -1;
}
