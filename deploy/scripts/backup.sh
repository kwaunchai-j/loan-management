#!/usr/bin/env bash
# Backs up the database and the uploaded files (slips) of the production stack (T-1001).
#   deploy/scripts/backup.sh                      # run from cron, see RUNBOOK.md
# Writes into BACKUP_DIR (default /var/backups/loan, mode 700):
#   db-YYYYmmdd-HHMMSS.dump       the whole database (pg_dump custom format)
#   files-YYYYmmdd-HHMMSS.tar     the slips and any staged import files
#   *.sha256                      checksums, checked again by restore.sh
# Both are checked for readability right after they are written; a backup that fails the check is
# deleted and the script exits with an error (so cron / monitoring sees it).
# BACKUP_PASSPHRASE_FILE=/etc/loan/backup.pass encrypts both files (AES-256, adds ".enc"): they hold
# names, phone numbers and slips. KEEP_DAYS (default 30) removes older backups made by this script.
# NOT in these backups: the env files in LOAN_ENV_DIR — above all FIELD_ENCRYPTION_KEY. Without that key
# the bank account numbers in a restored database cannot be read. Back it up separately (RUNBOOK.md).
# Keep a copy of the backups on ANOTHER machine, still in Thailand.
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="${COMPOSE:-$HERE/compose.sh}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/loan}"
KEEP_DAYS="${KEEP_DAYS:-30}"
PASS_FILE="${BACKUP_PASSPHRASE_FILE:-}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(TZ=Asia/Bangkok date +%Y%m%d-%H%M%S)"
db="$BACKUP_DIR/db-$stamp.dump"
files="$BACKUP_DIR/files-$stamp.tar"
cleanup_partial() { rm -f "$db" "$db.enc" "$files" "$files.enc" "$db.partial" "$files.partial"; }
trap 'rc=$?; if [ $rc -ne 0 ]; then echo "BACKUP FAILED — removing the incomplete files" >&2; cleanup_partial; fi' EXIT

encrypt() { openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASS_FILE"; }

echo "1/3 database"
$COMPOSE exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$db.partial"
# readable? (the table of contents must list at least the main tables)
toc="$($COMPOSE exec -T db pg_restore -l < "$db.partial")"
printf '%s\n' "$toc" | grep -q 'TABLE DATA public Contract' || { echo "the dump does not look like this system's database" >&2; exit 1; }
mv "$db.partial" "$db"

echo "2/3 files"
$COMPOSE exec -T api tar -C /data -cf - . > "$files.partial"
tar -tf - < "$files.partial" > /dev/null # (read from stdin: a path with a colon would be taken for a remote host)
mv "$files.partial" "$files"

if [ -n "$PASS_FILE" ]; then
  [ -s "$PASS_FILE" ] || { echo "BACKUP_PASSPHRASE_FILE is empty or missing" >&2; exit 1; }
  encrypt < "$db" > "$db.enc" && rm -f "$db"
  encrypt < "$files" > "$files.enc" && rm -f "$files"
  db="$db.enc"; files="$files.enc"
fi

echo "3/3 checksums and clean-up"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$db")" > "$(basename "$db").sha256" && sha256sum "$(basename "$files")" > "$(basename "$files").sha256" )
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*' -o -name 'files-*' \) -mtime "+$KEEP_DAYS" -delete

trap - EXIT
echo "OK  $(basename "$db")  $(basename "$files")  in $BACKUP_DIR"
