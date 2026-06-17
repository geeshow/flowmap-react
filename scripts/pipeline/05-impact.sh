#!/usr/bin/env bash
# Stage 4: per-root PR change-impact against each front graph → <graph>.impact.json
# (+ <graph>.impact/<n>.json shards). Mirrors flowmap-spring scripts/05-impact.sh.
#
# For each service graph `<OUT_DIR>/<root>/<BASE>.json`, the impact command auto-finds
# the git work tree from the graph's meta.root (walks up from REPO/<meta.root> to the
# nearest .git): a standalone checkout mines its own repo; a package split out of a
# MONOREPO mines the monorepo's git with the right path prefix. Merged PRs (git-first,
# gh fallback) are mined and each PR's changed nodes walked to the SCREENs they reach.
# A service with no git work tree at/above its checkout is skipped.
#
# Runs INCREMENTALLY by default (analyze only PRs merged since the last run, reusing
# the existing impact.json + shards) — set IMPACT_FULL=1 to force a clean full rebuild.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

IMPACT_MAX="${IMPACT_MAX:-10}"

# Incremental by default: reuse PRs already in each <graph>.impact.json and analyze
# only those merged since the last run (huge speedup on large repos). The first run
# (no prior impact.json) is a full analysis. Force a clean full rebuild with
# IMPACT_FULL=1 (e.g. periodically, after the graph changed a lot).
INCREMENTAL_FLAG=(--incremental)
case "$(echo "${IMPACT_FULL:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes) INCREMENTAL_FLAG=() ;;
esac

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
  root="$(basename "$(dirname "$g")")"   # service dir name, for logging only
  out="${g%.json}.impact.json"
  echo "      $root: $g → $out" >&2
  # impact resolves the git work tree + path prefix from the graph's meta.root,
  # relative to REPO — so monorepo packages mine the monorepo git correctly.
  if "$FLOWMAP" impact --repo-root "$REPO" --graph "$g" --out "$out" --max "$IMPACT_MAX" "${INCREMENTAL_FLAG[@]}"; then
    analyzed=$((analyzed + 1))
  else
    echo "  · $root: skip (no git work tree / no PR source / impact failed)" >&2
  fi
done
echo "[4] impact done: $analyzed analyzed" >&2
