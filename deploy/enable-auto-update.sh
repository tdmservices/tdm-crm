#!/usr/bin/env bash
# One-time: makes this VM pull and rebuild from GitHub every 5 minutes, so pushing to main deploys.
# Usage (on the VM):  bash ~/tdm-crm/deploy/enable-auto-update.sh
set -euo pipefail
DIR="${DIR:-$HOME/tdm-crm}"
chmod +x "$DIR/deploy/auto-update.sh"
( crontab -l 2>/dev/null | grep -v auto-update.sh; echo "*/5 * * * * $DIR/deploy/auto-update.sh >> $HOME/tdm-update.log 2>&1" ) | crontab -
echo "Auto-update enabled. Every push to main is live within 5 minutes. Log: ~/tdm-update.log"
