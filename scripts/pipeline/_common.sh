#!/usr/bin/env bash
# Shared setup for the staged pipeline scripts. Sourced by 0..3.*.sh.
# Mirrors ts-analyzer/src/cli.ts cmdPipeline: same config, names, and sub-commands.
set -euo pipefail

# Repo root = two levels up from this file (scripts/pipeline/ -> repo root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# Run everything from the repo root so relative paths (REPO=.repo, OUT_DIR=./json)
# resolve exactly like `./flowmap pipeline` does.
cd "$ROOT"

FLOWMAP="$ROOT/flowmap"
CONFIG="${FLOWMAP_CONFIG:-$ROOT/flowmap.config}"

# --- defaults (match cmdPipeline) ---
REPO=".repo"
PROJECT=""
NAME=""
OUT_DIR="."
BACKEND=""
MODE=""
ENV=""
ENV_PROFILE=""
WORKERS=""
NO_SPLIT=""
PULL="true"

# --- load KEY=VALUE config (overrides defaults) ---
if [ -f "$CONFIG" ]; then
  echo "config: $CONFIG" >&2
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
else
  echo "config: $CONFIG not found — using defaults / env" >&2
fi

# Output base name: NAME, else PROJECT, else "graph".
BASE="${NAME:-${PROJECT:-graph}}"
GRAPH_OUT="$OUT_DIR/$BASE.json"
SCREENS_OUT="$OUT_DIR/$BASE.screens.json"
mkdir -p "$OUT_DIR"

# Common flags shared by analyze (screens has its own lighter set).
COMMON_FLAGS=(--repo "$REPO")
[ -n "$PROJECT" ]     && COMMON_FLAGS+=(--project "$PROJECT")
[ -n "$MODE" ]        && COMMON_FLAGS+=(--mode "$MODE")
[ -n "$ENV" ]         && COMMON_FLAGS+=(--env "$ENV")
[ -n "$ENV_PROFILE" ] && COMMON_FLAGS+=(--env-profile "$ENV_PROFILE")
[ -n "$WORKERS" ]     && COMMON_FLAGS+=(--workers "$WORKERS")
case "$(echo "$NO_SPLIT" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes) COMMON_FLAGS+=(--no-split) ;;
esac

# List the front graphs to join: one `<OUT_DIR>/<service>/<base>.json` per
# service subdirectory (derived .join/.screens/.openapi/.impact siblings live
# alongside but are not graphs). Mirrors listGraphsToJoin. One path per line.
join_graphs() {
  local found=() f
  shopt -s nullglob
  for f in "$OUT_DIR"/*/"$BASE.json"; do
    found+=("$f")
  done
  shopt -u nullglob
  if [ ${#found[@]} -gt 0 ]; then
    printf '%s\n' "${found[@]}" | sort
  fi
}
