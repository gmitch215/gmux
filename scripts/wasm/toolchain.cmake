# wasm32-linux-musl through scripts/cc-strict: cmake -DCMAKE_TOOLCHAIN_FILE=scripts/wasm/toolchain.cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_C_COMPILER ${CMAKE_CURRENT_LIST_DIR}/../cc-strict)
if(DEFINED ENV{LINUX_WASM})
	set(CMAKE_AR $ENV{LINUX_WASM}/tools/fake-llvm/llvm-ar)
	set(CMAKE_RANLIB $ENV{LINUX_WASM}/tools/fake-llvm/llvm-ranlib)
endif()
# programs are wasm side modules the host loads, linked with -shared
set(CMAKE_EXE_LINKER_FLAGS_INIT "-Wl,-shared -fPIC")
set(CMAKE_C_FLAGS_INIT "-fPIC -D__linux__")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
