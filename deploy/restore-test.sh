#!/usr/bin/env bash
# Restore drill: restores a backup into a THROWAWAY container and compares row counts with production.
# Production is only read. Run it monthly, and after changing backup.sh.
#   bash restore-test.sh [/var/backups/doculex/doculex-YYYY-MM-DD.dump]   (default: newest)
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/doculex}"
dump="${1:-$(ls -1t "$BACKUP_DIR"/doculex-*.dump | head -n 1)}"
[ -f "$dump" ] || { echo "no dump found: $dump" >&2; exit 1; }

scratch="doculex-restore-test-$$"
cleanup() { docker rm -f "$scratch" > /dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> Restoring $dump into $scratch"
# No ports, no volume: it disappears with the container.
docker run -d --name "$scratch" -e POSTGRES_PASSWORD=restore-test pgvector/pgvector:pg17 > /dev/null
# Over TCP on purpose: during init the entrypoint's temporary server listens on the unix socket only,
# so this succeeds only once the final server is up.
until docker exec "$scratch" pg_isready -h 127.0.0.1 -U postgres -q; do sleep 1; done

docker exec "$scratch" createdb -U postgres doculex
# --no-owner/--no-acl: the doculex_app role doesn't exist here. --exit-on-error: any error fails the drill.
docker exec -i "$scratch" pg_restore -U postgres -d doculex --no-owner --no-acl --exit-on-error < "$dump"

count() { # $1 = psql command prefix, $2 = table
  $1 -tA -c "select count(*) from $2"
}
prod_psql="docker compose exec -T db psql -U postgres -d doculex"
test_psql="docker exec -i $scratch psql -U postgres -d doculex"

status=0
for table in documents chunks queries drizzle.__drizzle_migrations; do
  p="$(count "$prod_psql" "$table")"
  r="$(count "$test_psql" "$table")"
  # Production keeps receiving queries after the dump, so "restored <= production" is expected there.
  printf '%-32s production=%-8s restored=%s\n' "$table" "$p" "$r"
  if [ "$table" = queries ]; then [ "$r" -le "$p" ] || status=1; else [ "$r" = "$p" ] || status=1; fi
done

# The data must also be usable, not just present: pgvector installed and a vector query runs.
$test_psql -tA -c "select extversion from pg_extension where extname = 'vector'" | grep -q . || status=1
$test_psql -tA -c "select id from chunks where embedding is not null order by embedding <=> (select embedding from chunks where embedding is not null limit 1) limit 1" > /dev/null || status=1

if [ "$status" -eq 0 ]; then echo "==> Restore test PASSED"; else echo "==> Restore test FAILED" >&2; fi
exit "$status"
