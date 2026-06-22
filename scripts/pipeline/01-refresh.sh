#!/usr/bin/env bash
# Stage 0: refresh the analyzed checkout (git pull --ff-only), best-effort.
# Mirrors cmdPipeline.refreshRepo. Skipped when PULL is false/0/no.
. "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

case "$(echo "$PULL" | tr '[:upper:]' '[:lower:]')" in
  0|false|no)
    echo "[0] refresh skipped (PULL=$PULL)" >&2
    exit 0 ;;
esac

# Prefer the project dir, else the repo root — whichever is a git work tree.
for target in "${PROJECT:+$REPO/$PROJECT}" "$REPO"; do
  [ -n "$target" ] || continue
  if [ -d "$target" ] && git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    # Analysis is always master-based: switch to master before pull (no-op if already on
    # master; keeps current branch if master is absent/checkout fails).
    git -C "$target" checkout master >/dev/null 2>&1 || echo "[0] checkout master failed — keeping current branch" >&2
    echo "[0] pull: git -C $target pull --ff-only" >&2
    git -C "$target" pull --ff-only || echo "[0] pull failed — continuing with current checkout" >&2
    exit 0
  fi
done
echo "[0] refresh: no git work tree under $REPO — skipping" >&2
