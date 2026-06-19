#!/usr/bin/env bash
# Stage 4: PR change-impact, analyzed PER GIT REPO → <repoName>/<BASE>.impact.json
# (+ <BASE>.impact/<n>.json shards). Mirrors flowmap-spring scripts/05-impact.sh.
#
# `impact-repos` discovers every service graph under OUT_DIR and groups them by the
# git work tree resolved from each graph's meta.root (walks up from REPO/<meta.root>
# to the nearest .git). Each repo is analyzed ONCE against the MERGED graph of its
# sub-roots, so a MONOREPO's packages share a single, deduplicated impact spanning
# all of them (a changed shared module reaches screens in any package). The result is
# written to a folder named after the git work tree (<out-dir>/<repoName>/), so the web
# manifest links it as a repo-level entry; sub-roots' stale impact artifacts are pruned.
# A service with no git work tree at/above its checkout is skipped.
#
# Runs INCREMENTALLY by default (analyze only PRs merged since the last run, reusing
# the existing impact.json + shards) — set IMPACT_FULL=1 to force a clean full rebuild.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

IMPACT_MAX="${IMPACT_MAX:-10}"

INCREMENTAL_FLAG=(--incremental)
case "$(echo "${IMPACT_FULL:-}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes) INCREMENTAL_FLAG=() ;;
esac

echo "[4] impact (per-repo) → out-dir $OUT_DIR, max=$IMPACT_MAX PRs/repo" >&2
# ${arr[@]+"${arr[@]}"} expands safely under `set -u` even when the array is empty.
"$FLOWMAP" impact-repos --repo-root "$REPO" --out-dir "$OUT_DIR" --max "$IMPACT_MAX" \
  ${INCREMENTAL_FLAG[@]+"${INCREMENTAL_FLAG[@]}"}
