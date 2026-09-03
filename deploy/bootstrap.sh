#!/bin/bash
# LiteChat one-shot bootstrap for an Ubuntu VM on Oracle Cloud.
#
# Paste this into the Oracle console: Instance -> More actions -> Run command
# -> Create command, or run it in Cloud Shell / over SSH.
#
# EDIT THE THREE VALUES BELOW FIRST.
#
# It opens the guest firewall, installs Docker, clones the repo, writes .env
# and starts the stack. Safe to re-run: it updates instead of duplicating.

set -euxo pipefail

DOMAIN="chat.example.com"
ACME_EMAIL="you@example.com"
REPO="https://github.com/TechDlx/LiteChat.git"

APP_DIR=/opt/litechat

# --- 1. guest firewall -------------------------------------------------------
# The VCN security list is separate and must be done in the console.
for PORT in 80 443; do
  iptables -C INPUT -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null && continue
  # The rule must land ABOVE the chain's REJECT/DROP - iptables stops at the
  # first match, so anything below it is never reached. The REJECT's position
  # differs between Oracle images, so find it rather than assuming.
  POS=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" || $2=="DROP" {print $1; exit}')
  iptables -I INPUT "${POS:-1}" -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT
done

echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates iptables-persistent
netfilter-persistent save

iptables -L INPUT -n --line-numbers    # both ACCEPTs should be above the REJECT

# --- 2. docker ---------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker ubuntu 2>/dev/null || true
systemctl enable --now docker

# --- 3. the app --------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"
printf 'DOMAIN=%s\nACME_EMAIL=%s\n' "$DOMAIN" "$ACME_EMAIL" > .env

docker compose -f docker-compose.prod.yml up -d --build

# --- 4. report ---------------------------------------------------------------
sleep 5
docker compose -f docker-compose.prod.yml ps
echo "----------------------------------------------------------------"
echo "Deployed. If DNS for $DOMAIN already points here, Caddy will have"
echo "a certificate within a minute. Check from OUTSIDE the VM with:"
echo "  curl https://$DOMAIN/api/health"
echo "----------------------------------------------------------------"
