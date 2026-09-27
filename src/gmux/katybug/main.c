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
    int status = kb_run(cpu);
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
    if (getenv("KATYBUG_STATS"))
        fprintf(
            stderr,
            "katybug: %llu blocks; plan dropped %llu of %llu flag writes "
            "decoded, %llu of %llu run; grouped %llu of %llu accesses "
            "decoded\n",
            (unsigned long long) cpu->steps,
            (unsigned long long) cpu->plan_flags_removed,
            (unsigned long long) cpu->plan_flags,
            (unsigned long long) cpu->plan_flags_run,
            (unsigned long long) cpu->plan_flags_ran,
            (unsigned long long) cpu->plan_mem_grouped,
            (unsigned long long) cpu->plan_mem
        );
#ifdef KB_HOT
    kb_hot_dump(cpu);
#endif
#ifdef KB_COUNT
    if (getenv("KATYBUG_COUNT")) kb_count_report(cpu);
#endif
    return status;
}
