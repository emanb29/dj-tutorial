#!/usr/bin/env bash
# Fast-forwards a main checkout to the newest main commit whose CI push run passed, and never past
# it. A live dev server can run from the main checkout, so Vite and tsx hot-reload the
# result. Safe to run again and again (from cron, or after each merge): it does nothing when the
# checkout is already there, and refuses when the working tree is dirty, the checkout is not on
# main, or the green commit is not ahead of it.
#
#   scripts/follow-green-main.sh [path-to-main-checkout]   # default: this repo
set -euo pipefail

checkout="${1:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
cd "$checkout"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != main ]; then
  echo "follow-green-main: $checkout is on $branch, not main; switch it to main first." >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "follow-green-main: $checkout has uncommitted changes; commit or clean them, then run again." >&2
  exit 1
fi

git fetch --quiet origin main

green=$(gh run list --workflow CI --branch main --event push --status success --limit 1 --json headSha --jq '.[0].headSha // ""')
if [ -z "$green" ]; then
  echo "follow-green-main: no passing CI push run on main yet; nothing to do."
  exit 0
fi

here=$(git rev-parse HEAD)
if [ "$here" = "$green" ]; then
  echo "follow-green-main: already at the newest green main, ${green:0:7}."
  exit 0
fi
if git merge-base --is-ancestor "$green" "$here"; then
  echo "follow-green-main: ${here:0:7} is already past the newest green main, ${green:0:7}; leaving it."
  exit 0
fi
if ! git merge-base --is-ancestor "$here" "$green"; then
  echo "follow-green-main: ${here:0:7} is not an ancestor of the green ${green:0:7}, so this cannot fast-forward; reset main by hand." >&2
  exit 1
fi

git merge --ff-only --quiet "$green"
echo "follow-green-main: moved main from ${here:0:7} to ${green:0:7}."
