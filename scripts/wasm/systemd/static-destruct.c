// wasm has no linker-made section bounds; an empty list for the test programs
const char __start_SYSTEMD_STATIC_DESTRUCT[1] = {0};
extern const char __stop_SYSTEMD_STATIC_DESTRUCT[1]
    __attribute__((alias("__start_SYSTEMD_STATIC_DESTRUCT")));
