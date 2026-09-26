#!/usr/bin/env bash
# Doxygen over gmux's own C (the runtime and Katybug) into build-native/docs/html, the directory
# doxygen.sh publishes; docs/Doxyfile.in's @...@ placeholders are CMake's, filled in here instead
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/build-native
version=$(node -p "require('$root/package.json').version")
mkdir -p "$out"
sed -e "s|@PROJECT_VERSION@|$version|g" \
	-e "s|@CMAKE_CURRENT_SOURCE_DIR@|$root|g" \
	-e "s|@CMAKE_CURRENT_BINARY_DIR@|$out|g" \
	-e "s|^INPUT  *=.*|INPUT = $root/src/gmux $root/README.md|" \
	-e "s|^OPTIMIZE_OUTPUT_FOR_C  *=.*|OPTIMIZE_OUTPUT_FOR_C = YES|" \
	"$root/docs/Doxyfile.in" > "$out/Doxyfile"
doxygen "$out/Doxyfile"
test -f "$out/docs/html/index.html"
echo "build-native/docs/html written"
