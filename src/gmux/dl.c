// dlopen, dlsym, dlclose and dlerror over the host's exec registry
// (src/worker/machine/dl.ts): the file's bytes go to the host, which
// instantiates the precompiled side module registered under their hash into
// this process, its data in memory allocated here
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

long __gmux_dlprep(const void* bytes, unsigned long len, unsigned long* info);
long __gmux_dlopen(const void* bytes, unsigned long len, void* memory);
long __gmux_dlsym(long handle, const char* name);
long __gmux_dlclose(long handle);
long __gmux_dlerror(char* buffer, unsigned long size);

struct lib {
    long handle; // the host's; 0 is the program itself
    int refs;
    void* memory;
    struct lib* next;
    char path[256];
};

static struct lib self = {0, 1, 0, 0, ""};
static struct lib* libs;
static char error[512];
static int failed;

static void fail(const char* file, const char* why) {
    snprintf(error, sizeof error, "%s: %s", file, why);
    failed = 1;
}

static void host_failed(void) {
    __gmux_dlerror(error, sizeof error);
    failed = 1;
}

static int readable(const char* path) {
    return access(path, R_OK) == 0;
}

// a name without a slash is looked up in LD_LIBRARY_PATH, then /lib and
// /usr/lib
static int find(const char* file, char* out, size_t size) {
    if (strchr(file, '/')) return snprintf(out, size, "%s", file) < (int) size;
    const char* env = getenv("LD_LIBRARY_PATH");
    const char* dirs[] = {env ? env : "", "/lib", "/usr/lib"};
    for (int d = 0; d < 3; d++) {
        for (const char* p = dirs[d]; *p;) {
            size_t n = strcspn(p, ":");
            if (n &&
                snprintf(out, size, "%.*s/%s", (int) n, p, file) < (int) size &&
                readable(out))
                return 1;
            p += n + (p[n] == ':');
        }
    }
    return 0;
}

static void* slurp(const char* path, size_t* len) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    struct stat st;
    if (fd < 0 || fstat(fd, &st) < 0) {
        if (fd >= 0) close(fd);
        return 0;
    }
    char* bytes = malloc(st.st_size ? st.st_size : 1);
    size_t got = 0;
    while (bytes && got < (size_t) st.st_size) {
        ssize_t n = read(fd, bytes + got, st.st_size - got);
        if (n <= 0) break;
        got += n;
    }
    close(fd);
    if (!bytes || got != (size_t) st.st_size) {
        free(bytes);
        errno = bytes ? EIO : ENOMEM;
        return 0;
    }
    *len = got;
    return bytes;
}

void* dlopen(const char* file, int mode) {
    (void) mode; // every load is RTLD_NOW; symbols resolve at instantiation
    if (!file) return &self;
    char path[256];
    if (!find(file, path, sizeof path)) {
        fail(file, "cannot open shared object file: No such file or directory");
        return 0;
    }
    for (struct lib* l = libs; l; l = l->next)
        if (!strcmp(l->path, path)) {
            l->refs++;
            return l;
        }
    size_t len;
    void* bytes = slurp(path, &len);
    if (!bytes) {
        char why[128];
        snprintf(
            why, sizeof why, "cannot open shared object file: %s",
            strerror(errno)
        );
        fail(path, why);
        return 0;
    }
    unsigned long info[3]; // memory size, memory alignment, table size
    if (__gmux_dlprep(bytes, len, info) < 0) {
        host_failed();
        free(bytes);
        return 0;
    }
    size_t align = info[1] < sizeof(void*) ? sizeof(void*) : info[1];
    void* memory =
        aligned_alloc(align, (info[0] + align - 1) / align * align + align);
    struct lib* l = calloc(1, sizeof *l);
    if (!memory || !l) {
        free(bytes), free(memory), free(l);
        fail(path, "out of memory");
        return 0;
    }
    memset(memory, 0, info[0]);
    long handle = __gmux_dlopen(bytes, len, memory);
    free(bytes);
    if (handle < 0) {
        host_failed();
        free(memory), free(l);
        return 0;
    }
    *l = (struct lib){handle, 1, memory, libs, ""};
    snprintf(l->path, sizeof l->path, "%s", path);
    libs = l;
    void (*ctors)(void) =
        (void (*)(void)) __gmux_dlsym(handle, "__wasm_call_ctors");
    if (ctors) ctors();
    return l;
}

void* dlsym(void* restrict handle, const char* restrict name) {
    long v = 0;
    if (handle == RTLD_DEFAULT || handle == RTLD_NEXT) {
        v = __gmux_dlsym(0, name);
        for (struct lib* l = libs; !v && l; l = l->next)
            v = __gmux_dlsym(l->handle, name);
    }
    else {
        v = __gmux_dlsym(((struct lib*) handle)->handle, name);
    }
    if (!v)
        fail(
            handle == &self || !handle ? "main program"
                                       : ((struct lib*) handle)->path,
            "undefined symbol"
        );
    if (!v)
        snprintf(
            error + strlen(error), sizeof error - strlen(error), ": %s", name
        );
    return (void*) v;
}

/* musl's dlfcn.h renames dlsym to this under _REDIR_TIME64; side modules export
 * plain names, so no mapping is needed */
void* __dlsym_time64(void* restrict handle, const char* restrict name) {
    return dlsym(handle, name);
}

int dlclose(void* handle) {
    struct lib* l = handle;
    if (l == &self) return 0;
    if (--l->refs > 0) return 0;
    for (struct lib** p = &libs; *p; p = &(*p)->next)
        if (*p == l) {
            *p = l->next;
            break;
        }
    __gmux_dlclose(l->handle);
    free(l->memory);
    free(l);
    return 0;
}

char* dlerror(void) {
    if (!failed) return 0;
    failed = 0;
    return error;
}
