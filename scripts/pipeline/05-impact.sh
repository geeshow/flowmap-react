#!/usr/bin/env bash
# Stage 4: per-root PR change-impact against each front graph → <graph>.impact.json
# (+ <graph>.impact/<n>.json shards). Mirrors flowmap-spring scripts/05-impact.sh.
#
# For each service graph `<OUT_DIR>/<root>/<BASE>.json`, the matching checkout is REPO/<root>;
# a root that is its own standalone git repo is mined for merged PRs (git-first, gh
# fallback) and each PR's changed nodes are walked to the SCREENs they reach.
# Roots that are not standalone git repos are skipped.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

IMPACT_MAX="${IMPACT_MAX:-10}"

# Collect the per-root front graphs (same listing join uses).
GRAPHS=()
while IFS= read -r line; do
  [ -n "$line" ] && GRAPHS+=("$line")
done < <(join_graphs)
if [ ${#GRAPHS[@]} -eq 0 ]; then
  echo "[4] impact: no front graph in $OUT_DIR — run 1.analyze.sh first" >&2
  exit 1
fi

echo "[4] impact → ${#GRAPHS[@]} graph(s), max=$IMPACT_MAX PRs/project" >&2
analyzed=0
for g in "${GRAPHS[@]}"; do
  root="$(basename "$(dirname "$g")")"   # service dir name, e.g. front-official-desktop
  gitdir="$REPO/$root"
  if [ ! -d "$gitdir/.git" ]; then
    echo "  · $root: skip (not a standalone git repo at $gitdir)" >&2
    continue
  fi
  out="${g%.json}.impact.json"
  echo "      $root: $g → $out" >&2
  if "$FLOWMAP" impact --git "$gitdir" --graph "$g" --out "$out" --prefix "$root" --max "$IMPACT_MAX"; then
    analyzed=$((analyzed + 1))
  else
    echo "  · $root: skip (no PR source / impact failed)" >&2
  fi
done
echo "[4] impact done: $analyzed analyzed" >&2
