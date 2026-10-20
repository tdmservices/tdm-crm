#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VM (tested target: Oracle Cloud Always Free, Ubuntu 22.04/24.04).
# Usage:  curl -fsSL https://raw.githubusercontent.com/tdmservices/tdm-crm/main/deploy/setup-free-vm.sh | DOMAIN=tdmcrm.duckdns.org bash
set -euo pipefail
: "${DOMAIN:?Set DOMAIN to the hostname pointing at this VM, e.g. tdmcrm.duckdns.org}"
REPO="${REPO:-https://github.com/tdmservices/tdm-crm.git}"
DIR="${DIR:-$HOME/tdm-crm}"

echo "== Installing Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
echo "== Opening ports 80 and 443 in the VM firewall"
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
sudo apt-get install -y -q iptables-persistent >/dev/null 2>&1 && sudo netfilter-persistent save >/dev/null 2>&1 || true

echo "== Fetching the CRM"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR"
if [ ! -f .env ]; then
  echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
  echo "DOMAIN=$DOMAIN" >> .env
fi
echo "== Building and starting (first build takes a few minutes)"
sudo docker compose up -d --build
echo
echo "Done. Open https://$DOMAIN in a minute (HTTPS certificate is issued automatically)."
echo "Log in as abdul@tdm.services / Password123! and change the seed passwords first."
echo "To update later:  cd $DIR && git pull && sudo docker compose up -d --build"
