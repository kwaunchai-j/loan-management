#!/usr/bin/env bash
# Creates the production env files with RANDOM secrets, directly on the server (T-1001).
#   LOAN_ENV_DIR=/etc/loan SITE_ADDRESS=loan.example.co.th deploy/scripts/make-secrets.sh
# - writes db.env, api.env, compose.env into LOAN_ENV_DIR (mode 700 folder, mode 600 files)
# - never prints a secret (only file names) and never overwrites an existing file
# - leaves the LINE token and the VAPID keys for you to add (see RUNBOOK.md)
set -euo pipefail
umask 077
DIR="${LOAN_ENV_DIR:-/etc/loan}"
SITE="${SITE_ADDRESS:?set SITE_ADDRESS to the domain name, e.g. loan.example.co.th}"
mkdir -p "$DIR"
chmod 700 "$DIR"

for f in db.env api.env compose.env; do
  if [ -e "$DIR/$f" ]; then
    echo "$DIR/$f already exists — leaving all files untouched." >&2
    exit 1
  fi
done

hex()    { openssl rand -hex "$1"; }
b64()    { openssl rand -base64 "$1" | tr -d '\n'; }

DB_PASSWORD="$(hex 24)" # hex only, so it is safe inside the DATABASE_URL

cat > "$DIR/db.env" <<EOF
POSTGRES_USER=loan
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=loan_management
EOF

cat > "$DIR/api.env" <<EOF
# Secrets of the API. Back FIELD_ENCRYPTION_KEY up SEPARATELY from the database backups:
# without it the encrypted bank account numbers cannot be read again.
DATABASE_URL=postgresql://loan:$DB_PASSWORD@db:5432/loan_management?schema=public
SESSION_SECRET=$(b64 48)
FIELD_ENCRYPTION_KEY=$(b64 32)
# LINE Official Account channel access token (leave out until you have it):
# LINE_CHANNEL_ACCESS_TOKEN=
# Web Push: run deploy/scripts/make-vapid.sh you@your-domain to add the three VAPID lines.
EOF

cat > "$DIR/compose.env" <<EOF
SITE_ADDRESS=$SITE
# RELEASE=2026-10-30   # a label for the images, handy for rolling back
EOF

chmod 600 "$DIR/db.env" "$DIR/api.env" "$DIR/compose.env"
echo "Created $DIR/db.env, $DIR/api.env, $DIR/compose.env (random secrets, not shown)."
echo "Next: back up FIELD_ENCRYPTION_KEY somewhere safe, then follow RUNBOOK.md."
