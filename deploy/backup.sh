#!/usr/bin/env bash
# Nightly DocuLex backup — runs ON the VPS from cron:
#   15 3 * * * /opt/doculex/backup.sh >> /opt/doculex/backup.log 2>&1
# Custom format (-Fc): compressed, and pg_restore can restore single tables from it.
# pg_dump runs inside the db container, so its version always matches the server (17).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/doculex}"
KEEP_DAYS=7

cd "$(dirname "$0")"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"   # the queries table holds users' questions

file="$BACKUP_DIR/doculex-$(date +%F).dump"
# Write to .tmp and rename at the end: a crash mid-dump never leaves a truncated file named like a good one.
docker compose exec -T db pg_dump -U postgres -Fc doculex > "$file.tmp"
# An empty or unreadable dump must fail the job, not be kept for 7 days.
docker compose exec -T db pg_restore --list < "$file.tmp" > /dev/null
mv "$file.tmp" "$file"
chmod 600 "$file"

# -mtime +6: older than 7 full days. Only our own file pattern, never anything else in the directory.
find "$BACKUP_DIR" -name 'doculex-*.dump' -mtime +$((KEEP_DAYS - 1)) -delete

echo "$(date -Is) backup ok: $file ($(du -h "$file" | cut -f1))"
# These copies are on the same disk as the database. Copy them off the VPS too (rclone, scp to another
# machine) — a disk failure or a deleted VPS takes both otherwise.
