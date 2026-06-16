#!/usr/bin/env bash
# Run the full staged pipeline in order (== `./flowmap pipeline`).
# Pass stage numbers to run a subset, e.g.  ./run-all.sh 2 4   (analyze + join).
# Stage scripts are named `NN-<name>.sh`; numbers may be given with or without the
# leading zero (2 == 02). Default (no args) runs 01..04 (impact 05 is opt-in).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stages=("$@")
[ ${#stages[@]} -eq 0 ] && stages=(1 2 3 4)

for n in "${stages[@]}"; do
  nn=$(printf '%02d' "$((10#$n))")
  script=$(ls "$DIR/$nn"-*.sh 2>/dev/null | head -1 || true)
  if [ -z "$script" ]; then
    echo "run-all: no stage script for '$n'" >&2
    exit 2
  fi
  bash "$script"
done
echo "done." >&2
