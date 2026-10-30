#!/usr/bin/env bash
# Runs docker compose for the production stack with the right files:
#   deploy/scripts/compose.sh up -d --build
#   deploy/scripts/compose.sh ps
# LOAN_ENV_DIR (default /etc/loan) holds db.env, api.env and compose.env: secrets, kept OUT of the repository.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# (only matters when this is run from Git Bash on Windows: Docker wants a Windows-style path)
command -v cygpath > /dev/null 2>&1 && ROOT="$(cygpath -m "$ROOT")"
export LOAN_ENV_DIR="${LOAN_ENV_DIR:-/etc/loan}"
if [ ! -f "$LOAN_ENV_DIR/compose.env" ]; then
  echo "Missing $LOAN_ENV_DIR/compose.env — run deploy/scripts/make-secrets.sh first." >&2
  exit 1
fi
exec docker compose --env-file "$LOAN_ENV_DIR/compose.env" -f "$ROOT/deploy/docker-compose.prod.yml" "$@"
