#!/usr/bin/env bash
# Stage 1: analyze → <OUT_DIR>/<BASE>.json (per-root <BASE>-*.json when split).
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

echo "[1] analyze → $GRAPH_OUT" >&2
"$FLOWMAP" analyze "${COMMON_FLAGS[@]}" --out "$GRAPH_OUT"
