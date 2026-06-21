#!/usr/bin/env bash
# Build the flowmap-react analyzer (ts-analyzer): install deps + compile TS.
# Produces ts-analyzer/dist/cli.js, which `./flowmap` and the pipeline scripts run.
#
#   ./scripts/build.sh           # install deps (if needed) + tsc build
#   ./scripts/build.sh --test    # build, then run the vitest suite
#   ./scripts/build.sh --clean   # remove dist/ before building
#   CI=1 ./scripts/build.sh      # always reinstall deps (clean install)
set -euo pipefail

# Repo root = one level up from this file (scripts/ -> repo root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANALYZER="$ROOT/ts-analyzer"
cd "$ROOT"

RUN_TEST=false
CLEAN=false
for arg in "$@"; do
  case "$arg" in
    --test)  RUN_TEST=true ;;
    --clean) CLEAN=true ;;
    -h|--help)
      sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "build: unknown option '$arg' (try --help)" >&2
      exit 2 ;;
  esac
done

if [ ! -f "$ANALYZER/package.json" ]; then
  echo "build: $ANALYZER/package.json not found — wrong directory?" >&2
  exit 1
fi

# 1) Install deps — skip when node_modules already present (unless CI is set).
if [ "${CI:-}" = "1" ] || [ ! -d "$ANALYZER/node_modules" ]; then
  echo "[build] installing ts-analyzer dependencies…" >&2
  npm --prefix "$ANALYZER" install --no-audit --no-fund
else
  echo "[build] deps present — skipping install (set CI=1 to force reinstall)" >&2
fi

# 2) Clean previous output if requested.
if [ "$CLEAN" = true ]; then
  echo "[build] cleaning $ANALYZER/dist…" >&2
  rm -rf "$ANALYZER/dist"
fi

# 3) Compile TypeScript.
echo "[build] compiling (tsc)…" >&2
npm --prefix "$ANALYZER" run build

# 4) Optional test run.
if [ "$RUN_TEST" = true ]; then
  echo "[build] running tests…" >&2
  npm --prefix "$ANALYZER" test
fi

echo "[build] done → $ANALYZER/dist/cli.js" >&2
