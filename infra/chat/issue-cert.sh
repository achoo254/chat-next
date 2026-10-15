#!/bin/bash
# Let's Encrypt certificate through a DNS-01 challenge on Cloudflare:
#   bash issue-cert.sh                          chat.hoandat.com + *.chat.hoandat.com
#   bash issue-cert.sh media-chat.hoandat.com   that host only
# Renewed by certbot's timer with nginx reloaded after each renewal. Run as root;
# idempotent. Reuses the Zone:DNS:Edit token already on this server
# (/etc/letsencrypt/cloudflare-localman.ini, usable only from this IP); the
# token is never printed.
set -euo pipefail

DOMAIN="${1:-chat.hoandat.com}"
CREDENTIALS=/etc/letsencrypt/cloudflare-localman.ini

die() { echo "issue-cert: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -s "$CREDENTIALS" ] || die "missing $CREDENTIALS (see localman-next infra/localman/issue-wildcard-cert.sh)"
certbot plugins 2>/dev/null | grep -q dns-cloudflare || die "certbot dns-cloudflare plugin missing"

if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
	echo "certificate for $DOMAIN already exists"
	exit 0
fi

# The chat host also covers its subdomains; other hosts get a single name.
NAMES=(-d "$DOMAIN")
[ "$DOMAIN" = chat.hoandat.com ] && NAMES+=(-d "*.$DOMAIN")

certbot certonly --non-interactive --agree-tos \
	--dns-cloudflare --dns-cloudflare-credentials "$CREDENTIALS" \
	--dns-cloudflare-propagation-seconds 30 \
	--cert-name "$DOMAIN" "${NAMES[@]}" \
	--deploy-hook "systemctl reload nginx"
echo "issue-cert: issued $DOMAIN"
