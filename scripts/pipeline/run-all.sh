#!/usr/bin/env bash
# Run the full staged pipeline in order (== `./flowmap pipeline`).
# Pass stage numbers to run a subset, e.g.  ./run-all.sh 1 3   (analyze + join).
# Stage scripts are named `<n>-<name>.sh`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

stages=("$@")
[ ${#stages[@]} -eq 0 ] && stages=(0 1 2 3)

for n in "${stages[@]}"; do
  script=$(ls "$DIR/$n"-*.sh 2>/dev/null | head -1 || true)
  if [ -z "$script" ]; then
    echo "run-all: no stage script for '$n'" >&2
    exit 2
  fi
  bash "$script"
done
echo "done." >&2
