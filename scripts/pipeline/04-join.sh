#!/usr/bin/env bash
# Stage 3: join each front graph against BACKEND → <graph>.join.json.
# Reuses the analyze output, so run stage 1 first. Skipped if BACKEND is unset/missing.
# BACKEND may be a CSV of graphs (e.g. spring `_combined.json,../flowmap-nexcore/json/_combined.json`):
# the join unions every backend's controllers + aliases into one match index.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

if [ -z "$BACKEND" ]; then
  echo "[3] join skipped — set BACKEND in $CONFIG to enable" >&2
  exit 0
fi
# Validate each CSV entry; skip the whole stage if any backend graph is missing.
IFS=',' read -ra _BACKENDS <<< "$BACKEND"
for _b in "${_BACKENDS[@]}"; do
  _b="${_b#"${_b%%[![:space:]]*}"}"; _b="${_b%"${_b##*[![:space:]]}"}"  # trim
  if [ -n "$_b" ] && [ ! -f "$_b" ]; then
    echo "[3] join skipped — backend graph not found: $_b" >&2
    exit 0
  fi
done

GRAPHS=()
while IFS= read -r line; do
  [ -n "$line" ] && GRAPHS+=("$line")
done < <(join_graphs)
if [ ${#GRAPHS[@]} -eq 0 ]; then
  echo "[3] join: no front graph in $OUT_DIR — run 1.analyze.sh first" >&2
  exit 1
fi

# Optional fe-svc↔backend-project affinity hints (breaks same-path ambiguous ties).
AFF_ARGS=()
if [ -n "$AFFINITY" ] && [ -f "$AFFINITY" ]; then
  AFF_ARGS=(--affinity "$AFFINITY")
elif [ -n "$AFFINITY" ]; then
  echo "[3] AFFINITY set but not found: $AFFINITY — joining without affinity hints" >&2
fi

echo "[3] join → ${#GRAPHS[@]} graph(s) against $BACKEND${AFFINITY:+ (affinity: $AFFINITY)}" >&2
for g in "${GRAPHS[@]}"; do
  out="${g%.json}.join.json"
  echo "      $g → $out" >&2
  "$FLOWMAP" join --graph "$g" --backend "$BACKEND" --out "$out" "${AFF_ARGS[@]}"
done
