#!/usr/bin/env bash
# Adds a new VAPID key pair for Web Push to api.env WITHOUT printing it (T-1001).
#   deploy/scripts/make-vapid.sh you@your-domain.example
# Run it once. Changing the keys later makes every browser subscribe to push again.
set -euo pipefail
umask 077
CONTACT="${1:?usage: make-vapid.sh contact@your-domain.example (a real address the push services can reach)}"
DIR="${LOAN_ENV_DIR:-/etc/loan}"
ENV_FILE="$DIR/api.env"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — run make-secrets.sh first." >&2; exit 1; }
if grep -q '^VAPID_' "$ENV_FILE"; then
  echo "api.env already has VAPID_* lines — not changing them." >&2
  exit 1
fi
# the keys are generated inside the tools container and written straight into the file
LINES="$("$HERE/compose.sh" run --rm -T tools node -e "
const w=require('web-push');const k=w.generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY='+k.publicKey);console.log('VAPID_PRIVATE_KEY='+k.privateKey);
")"
{
  echo ""
  echo "# Web Push (VAPID) — created $(TZ=Asia/Bangkok date +%F)"
  echo "$LINES"
  echo "VAPID_SUBJECT=mailto:$CONTACT"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Added VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT to $ENV_FILE (not shown). Restart the api: compose.sh up -d api"
