#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

/* programs that import entries a stream mirror cannot serve: hdr uses
 * deflateSetHeader and inflateGetHeader (pointers into the guest's own
 * structs), back uses inflateBack (callbacks). Each also runs plain deflate and
 * inflate streams, which katybug must leave to the guest's libz for the whole
 * process: the output is the same with its stream kernels on and off */

static uint64_t fnv(const void* p, size_t n) {
    const uint8_t* b = p;
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
    return h;
}

static uint8_t* data(size_t n) {
    uint8_t* b = malloc(n);
    uint64_t s = 88172645463325252ull;
    for (size_t i = 0; i < n; i++) {
        s ^= s << 13, s ^= s >> 7, s ^= s << 17;
        b[i] = (uint8_t) ("abcdefgh \n"[s % 10] + (s >> 60 == 0));
    }
    return b;
}

static void plain(void) {
    uint8_t* in = data(50000);
    uint8_t out[60000], back[60000];
    z_stream z;
    memset(&z, 0, sizeof z);
    deflateInit(&z, 6);
    z.next_in = in;
    z.avail_in = 50000;
    z.next_out = out;
    z.avail_out = sizeof out;
    int rc = deflate(&z, Z_FINISH);
    size_t n = sizeof out - z.avail_out;
    printf(
        "plain deflate rc %d n %zu h %016llx\n", rc, n,
        (unsigned long long) fnv(out, n)
    );
    deflateEnd(&z);
    memset(&z, 0, sizeof z);
    inflateInit(&z);
    z.next_in = out;
    z.avail_in = (uInt) n;
    z.next_out = back;
    z.avail_out = sizeof back;
    rc = inflate(&z, Z_FINISH);
    printf(
        "plain inflate rc %d n %lu same %d\n", rc, (unsigned long) z.total_out,
        z.total_out == 50000 && !memcmp(back, in, 50000)
    );
    inflateEnd(&z);
    free(in);
}

static void hdr(void) {
    uint8_t* in = data(20000);
    uint8_t out[30000], back[30000];
    char name[] = "zbench.txt", comment[] = "a header the guest owns";
    uint8_t extra[] = {1, 2, 3, 4, 5};
    gz_header h;
    memset(&h, 0, sizeof h);
    h.time = 1234567;
    h.os = 3;
    h.name = (Bytef*) name;
    h.comment = (Bytef*) comment;
    h.extra = extra;
    h.extra_len = sizeof extra;
    h.hcrc = 1;
    z_stream z;
    memset(&z, 0, sizeof z);
    deflateInit2(&z, 6, Z_DEFLATED, 31, 8, 0);
    printf("setheader %d\n", deflateSetHeader(&z, &h));
    z.next_in = in;
    z.avail_in = 20000;
    z.next_out = out;
    z.avail_out = sizeof out;
    int rc = deflate(&z, Z_FINISH);
    size_t n = sizeof out - z.avail_out;
    printf(
        "deflate rc %d n %zu h %016llx\n", rc, n,
        (unsigned long long) fnv(out, n)
    );
    deflateEnd(&z);
    gz_header g;
    uint8_t gname[64], gcomment[64], gextra[16];
    memset(&g, 0, sizeof g);
    g.name = gname, g.name_max = sizeof gname;
    g.comment = gcomment, g.comm_max = sizeof gcomment;
    g.extra = gextra, g.extra_max = sizeof gextra;
    memset(&z, 0, sizeof z);
    inflateInit2(&z, 31);
    printf("getheader %d\n", inflateGetHeader(&z, &g));
    z.next_in = out;
    z.avail_in = (uInt) n;
    z.next_out = back;
    z.avail_out = sizeof back;
    rc = inflate(&z, Z_FINISH);
    printf(
        "inflate rc %d n %lu same %d done %d time %lu os %d name %s comment %s "
        "extra %u hcrc %d\n",
        rc, (unsigned long) z.total_out, !memcmp(back, in, 20000), g.done,
        g.time, g.os, gname, gcomment, g.extra_len, g.hcrc
    );
    inflateEnd(&z);
    free(in);
}

struct io {
    const uint8_t* in;
    size_t n, pos, chunk;
    uint8_t out[65536];
    size_t outn;
    uLong crc;
};

static unsigned in_cb(void* d, unsigned char** buf) {
    struct io* io = d;
    size_t take = io->n - io->pos < io->chunk ? io->n - io->pos : io->chunk;
    *buf = (unsigned char*) io->in + io->pos;
    io->pos += take;
    return (unsigned) take;
}

static int out_cb(void* d, unsigned char* buf, unsigned len) {
    struct io* io = d;
    io->crc = crc32(io->crc, buf, len);
    io->outn += len;
    return 0;
}

static void back(void) {
    uint8_t* in = data(40000);
    uint8_t raw[50000];
    z_stream z;
    memset(&z, 0, sizeof z);
    deflateInit2(&z, 6, Z_DEFLATED, -15, 8, 0);
    z.next_in = in;
    z.avail_in = 40000;
    z.next_out = raw;
    z.avail_out = sizeof raw;
    deflate(&z, Z_FINISH);
    size_t n = sizeof raw - z.avail_out;
    deflateEnd(&z);
    static const size_t chunks[] = {1, 100, 4096, 65536};
    for (size_t i = 0; i < 4; i++) {
        struct io* io = calloc(1, sizeof *io);
        io->in = raw, io->n = n, io->chunk = chunks[i],
        io->crc = crc32(0, NULL, 0);
        uint8_t* win = malloc(32768);
        memset(&z, 0, sizeof z);
        int rc = inflateBackInit(&z, 15, win);
        int rc2 = inflateBack(&z, in_cb, io, out_cb, io);
        printf(
            "back chunk %zu init %d rc %d out %zu crc %08lx same %d end %d\n",
            chunks[i], rc, rc2, io->outn, io->crc,
            io->crc == crc32(crc32(0, NULL, 0), in, 40000), inflateBackEnd(&z)
        );
        free(win);
        free(io);
    }
    free(in);
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "hdr")) return plain(), hdr(), 0;
    if (argc > 1 && !strcmp(argv[1], "back")) return plain(), back(), 0;
    fprintf(stderr, "usage: zpoison hdr | back\n");
    return 2;
}
