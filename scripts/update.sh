#!/usr/bin/env bash
# Pull upstream (mym0404/aside-relay) into this fork, rebuild the web app and restart the bridge.
# Usage: scripts/update.sh [--no-push]
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || { echo "Switch to main first (on $BRANCH)"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Working tree has uncommitted changes; commit or stash first"; exit 1; }
git fetch origin
BEHIND=$(git rev-list --count HEAD..origin/main)
if [ "$BEHIND" -eq 0 ]; then echo "Already up to date with upstream."; else
  echo "Merging $BEHIND upstream commit(s)"
  git merge --no-edit origin/main || { echo "Merge conflict: resolve it, commit, then re-run."; exit 1; }
  npm ci --silent
fi
npm run build
npm run test:unit
launchctl kickstart -k "gui/$(id -u)/com.aside-relay"
[ "${1:-}" = "--no-push" ] || { git remote get-url fork >/dev/null 2>&1 && git push fork main; }
echo "Done. Relaunch the phone app to load the new build."
