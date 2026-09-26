#!/usr/bin/env bash
# the asset a publish replaces; any change makes a new Worker version
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p assets
echo "published $(date +%s)" > assets/published.txt
