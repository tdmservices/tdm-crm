#!/usr/bin/env bash
# Pulls the latest main from GitHub and rebuilds when something changed. Installed as a cron job by enable-auto-update.sh.
set -euo pipefail
DIR="${DIR:-$HOME/tdm-crm}"
cd "$DIR"
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "$(date -Is) updating to $(git rev-parse --short origin/main)"
  git pull -q --ff-only origin main
  sudo docker compose up -d --build 2>&1 | tail -3
  sudo docker image prune -f >/dev/null 2>&1 || true
fi
