#!/usr/bin/env bash
# Restores a backup made by backup.sh (T-1001).
#
#   deploy/scripts/restore.sh check /var/backups/loan/db-20261030-023000.dump
#       Restores into a SCRATCH database (loan_restore_check), shows what it contains, then deletes the
#       scratch database. The live system is not touched. Do this after every change to the backup set,
#       and at least once a month: a backup that was never restored is only a hope.
#
#   CONFIRM_REPLACE_LIVE=yes deploy/scripts/restore.sh live DB_DUMP [FILES_TAR]
#       DISASTER RECOVERY. Stops the api and web, REPLACES the live database (and the slips, if FILES_TAR is
#       given) with the backup, then starts them again. Everything entered after the backup is lost.
#       Make a fresh backup of the current state first (backup.sh) unless it is truly destroyed.
#
# Encrypted backups (*.enc) need BACKUP_PASSPHRASE_FILE. A .sha256 file next to a backup is checked first.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${COMPOSE:-$HERE/compose.sh}"
MODE="${1:-}"
DUMP="${2:-}"
FILES="${3:-}"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-}"
SCRATCH_DB="loan_restore_check"
[ -n "$MODE" ] && [ -n "$DUMP" ] || { sed -n '2,17p' "${BASH_SOURCE[0]}" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "No such file: $DUMP" >&2; exit 1; }

verify_sum() {
  local f="$1"
  if [ -f "$f.sha256" ]; then
    ( cd "$(dirname "$f")" && sha256sum -c "$(basename "$f").sha256" > /dev/null ) || { echo "CHECKSUM MISMATCH for $f — this backup is damaged." >&2; exit 1; }
    echo "checksum ok: $(basename "$f")"
  else
    echo "no checksum file for $(basename "$f") (skipping the check)"
  fi
}
# prints the (decrypted) content of a backup file on stdout
content() {
  case "$1" in
    *.enc)
      [ -s "$PASS_FILE" ] || { echo "$1 is encrypted: set BACKUP_PASSPHRASE_FILE" >&2; exit 1; }
      openssl enc -d -aes-256-cbc -pbkdf2 -pass "file:$PASS_FILE" < "$1" ;;
    *) cat "$1" ;;
  esac
}
psql_admin() { $COMPOSE exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tA' ; }

verify_sum "$DUMP"
[ -z "$FILES" ] || { [ -f "$FILES" ] || { echo "No such file: $FILES" >&2; exit 1; }; verify_sum "$FILES"; }

case "$MODE" in
  check)
    echo "restoring into the scratch database $SCRATCH_DB ..."
    echo "DROP DATABASE IF EXISTS $SCRATCH_DB;" | psql_admin > /dev/null
    echo "CREATE DATABASE $SCRATCH_DB;" | psql_admin > /dev/null
    trap 'echo "DROP DATABASE IF EXISTS '"$SCRATCH_DB"';" | psql_admin > /dev/null 2>&1 || true' EXIT
    content "$DUMP" | $COMPOSE exec -T db sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $SCRATCH_DB --no-owner --exit-on-error"
    echo "restored. Row counts:"
    for t in User Borrower LoanRequest Contract Disbursement Payment LateFeeAccrual AuditLog ImportBatch; do
      n="$($COMPOSE exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d $SCRATCH_DB -tA -c 'select count(*) from \"$t\"'")"
      printf '  %-16s %s\n' "$t" "$n"
    done
    m="$($COMPOSE exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d $SCRATCH_DB -tA -c 'select count(*) from _prisma_migrations where finished_at is not null'")"
    echo "  migrations applied: $m"
    echo "CHECK OK — the backup can be restored. The scratch database has been removed."
    ;;
  live)
    [ "${CONFIRM_REPLACE_LIVE:-}" = "yes" ] || { echo "Refusing: this REPLACES the live database. Set CONFIRM_REPLACE_LIVE=yes to go on." >&2; exit 1; }
    # prove the backup restores BEFORE anything is destroyed
    echo "step 1: test-restoring the backup into a scratch database first ..."
    "${BASH_SOURCE[0]}" check "$DUMP" > /dev/null
    echo "step 2: stopping api and web ..."
    $COMPOSE stop api web
    echo "step 3: replacing the live database ..."
    $COMPOSE exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -tA -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\""' > /dev/null
    content "$DUMP" | $COMPOSE exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error'
    if [ -n "$FILES" ]; then
      echo "step 4: replacing the slips and files ..."
      content "$FILES" | $COMPOSE run --rm -T tools sh -c 'find /data -mindepth 1 -delete && tar -C /data -xf - && chown -R 1000:1000 /data'
    fi
    echo "step 5: starting api and web ..."
    $COMPOSE up -d api web
    echo "LIVE RESTORE DONE. Check the site, then run verify-deploy.sh."
    ;;
  *) echo "mode must be: check | live" >&2; exit 2 ;;
esac
