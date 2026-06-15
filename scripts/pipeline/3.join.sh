#!/usr/bin/env bash
# Stage 3: join each front graph against BACKEND → <graph>.join.json.
# Reuses the analyze output, so run stage 1 first. Skipped if BACKEND is unset/missing.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

if [ -z "$BACKEND" ]; then
  echo "[3] join skipped — set BACKEND in $CONFIG to enable" >&2
  exit 0
fi
if [ ! -f "$BACKEND" ]; then
  echo "[3] join skipped — backend graph not found: $BACKEND" >&2
  exit 0
fi

GRAPHS=()
while IFS= read -r line; do
  [ -n "$line" ] && GRAPHS+=("$line")
done < <(join_graphs)
if [ ${#GRAPHS[@]} -eq 0 ]; then
  echo "[3] join: no front graph in $OUT_DIR — run 1.analyze.sh first" >&2
  exit 1
fi

echo "[3] join → ${#GRAPHS[@]} graph(s) against $BACKEND" >&2
for g in "${GRAPHS[@]}"; do
  out="${g%.json}.join.json"
  echo "      $g → $out" >&2
  "$FLOWMAP" join --graph "$g" --backend "$BACKEND" --out "$out"
done
