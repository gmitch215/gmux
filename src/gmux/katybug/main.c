#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kb.h"

extern char** environ;
const char* kb_self;

/* this katybug's path, for execve: argv[0], or found on PATH when it has no
 * slash */
static const char* self(const char* argv0) {
    const char* path = getenv("PATH");
    if (strchr(argv0, '/') || !path) return argv0;
    static char buf[4096];
    for (const char* p = path; *p;) {
        size_t n = strcspn(p, ":");
        if (n && n + strlen(argv0) + 2 < sizeof buf) {
            memcpy(buf, p, n);
            buf[n] = '/';
            strcpy(buf + n + 1, argv0);
            if (access(buf, X_OK) == 0) return buf;
        }
        p += n + (p[n] == ':');
    }
    return argv0;
}

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: katybug <x86-64 or aarch64 ELF> [args...]\n");
        return 2;
    }
    kb_self = self(argv[0]);
    const char* path = argv[1];
    struct kb_cpu* cpu = calloc(1, sizeof *cpu);
    if (argc == 3 && strcmp(argv[1], "--katybug-resume") ==
                         0) /* a guest fork's child (fork.c) */
    {
        if (kb_resume(cpu, atoi(argv[2]))) {
            fprintf(
                stderr, "katybug: fork: the parent's state did not arrive\n"
            );
            return 127;
        }
        return kb_run(cpu);
    }
    if (argc >= 4 && !strcmp(argv[1], "--wasm"))
        return kb_wasm_main(cpu, argc, argv);
    /* katybug's own KATYBUG_* settings are not the guest's environment */
    int n = 0;
    while (environ[n]) n++;
    char** env = calloc((size_t) n + 1, sizeof *env);
    for (int i = 0, j = 0; i < n; i++)
        if (strncmp(environ[i], "KATYBUG_", 8) != 0) env[j++] = environ[i];
    /* an execve from a guest carries the argv[0] it asked for */
    if (getenv("KATYBUG_ARGV0")) argv[1] = getenv("KATYBUG_ARGV0");
    int rc = kb_load_elf(cpu, path, argc - 1, argv + 1, env);
    if (rc) {
        fprintf(stderr, "katybug: cannot load %s (%d)\n", argv[1], rc);
        return 126;
    }
    kb_sig_inherit(cpu);
    if (getenv("KATYBUG_TRACE"))
        cpu->trace = fopen(getenv("KATYBUG_TRACE"), "w");
    cpu->noplan =
        getenv("KATYBUG_PLAN") && !strcmp(getenv("KATYBUG_PLAN"), "0");
    cpu->segments = KB_TRACE;
    if (getenv("KATYBUG_SEGMENTS")) {
        int s = atoi(getenv("KATYBUG_SEGMENTS"));
        cpu->segments = s < 1 ? 1 : s > KB_SEGS - 1 ? KB_SEGS - 1 : s;
    }
    kb_persist_load(cpu, path);
    int status = kb_run(cpu);
    kb_persist_save(cpu);
    if (cpu->trace) fclose(cpu->trace);
    if (cpu->fault && !cpu->exited) {
        uint8_t* p = kb_host(cpu, cpu->pc, 4);
        fprintf(
            stderr, "katybug: %s at %#llx", cpu->fault,
            (unsigned long long) cpu->pc
        );
        if (p)
            fprintf(stderr, " (%02x %02x %02x %02x)", p[0], p[1], p[2], p[3]);
        fprintf(
            stderr, " after %llu blocks\n", (unsigned long long) cpu->steps
        );
    }
    /* the decoded code held at the end: blocks and their ops */
    uint64_t held = 0, held_ops = 0;
    for (int h = 0; getenv("KATYBUG_STATS") && h < 4096; h++)
        for (struct kb_block* b = cpu->cache[h]; b; b = b->chain)
            held++, held_ops += (uint64_t) b->n;
    if (getenv("KATYBUG_STATS"))
        fprintf(
            stderr,
            "katybug: %llu blocks; plan dropped %llu of %llu flag writes "
            "decoded, %llu of %llu run; grouped %llu of %llu accesses "
            "decoded; dropped %llu of %llu pure ops decoded, %llu of %llu "
            "ops run; %llu traces, %llu side exits; %llu blocks and %llu "
            "ops held; %llu decoded, %llu from the cache; %llu lookups\n",
            (unsigned long long) cpu->steps,
            (unsigned long long) cpu->plan_flags_removed,
            (unsigned long long) cpu->plan_flags,
            (unsigned long long) cpu->plan_flags_run,
            (unsigned long long) cpu->plan_flags_ran,
            (unsigned long long) cpu->plan_mem_grouped,
            (unsigned long long) cpu->plan_mem,
            (unsigned long long) cpu->plan_ops_removed,
            (unsigned long long) cpu->plan_ops,
            (unsigned long long) cpu->plan_ops_run,
            (unsigned long long) cpu->plan_ops_ran,
            (unsigned long long) cpu->traces,
            (unsigned long long) cpu->trace_exits, (unsigned long long) held,
            (unsigned long long) held_ops, (unsigned long long) cpu->decoded,
            (unsigned long long) cpu->loaded, (unsigned long long) cpu->lookups
        );
#ifdef KB_HOT
    kb_hot_dump(cpu);
#endif
#ifdef KB_COUNT
    if (getenv("KATYBUG_COUNT")) kb_count_report(cpu);
#endif
    return status;
}
