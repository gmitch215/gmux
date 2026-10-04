#!/usr/bin/env bash
# stages gmux-core.wasm for the probe Worker: experiments/core-sched/build.sh
# then, from this directory: bunx wrangler dev --local, and GET / answers {"ok":true,...}
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
"$here/../../scripts/build-core.sh" "$here/src" > /dev/null
