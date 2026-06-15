#!/usr/bin/env bash
# Stage 2: screens → <OUT_DIR>/<BASE>.screens.json
# (screens has its own light path — no --workers/--no-split).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

SCREENS_FLAGS=(--repo "$REPO")
[ -n "$PROJECT" ] && SCREENS_FLAGS+=(--project "$PROJECT")

echo "[2] screens → $SCREENS_OUT" >&2
"$FLOWMAP" screens "${SCREENS_FLAGS[@]}" --out "$SCREENS_OUT"
