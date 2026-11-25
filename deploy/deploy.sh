#!/usr/bin/env bash
# DocuLex deploy — runs ON the VPS in /opt/doculex. Called by the GitLab deploy job.
#
#   bash deploy.sh <image-tag>        deploy that image (the commit SHA built by CI)
#   bash deploy.sh <older-tag>        rollback: same script, an older image; no rebuild
#
# Order: pull -> db up -> migrate (new image) -> start new app -> require "status":"ok".
# - Pull or migration fails: the old container was never touched and keeps serving.
#   Migrations run in one transaction, so a failed one leaves the schema as it was.
# - New app unhealthy: the previous image is started again and the script fails.
#   The migration is NOT undone (Drizzle has no down migrations), so every migration must keep
#   working with the previous release: add columns/tables, never rename or drop in the same release.
set -euo pipefail

NEW_TAG="${1:?usage: deploy.sh <image-tag>}"
cd "$(dirname "$0")"

# One deploy at a time, even if someone runs this by hand while CI deploys.
exec 9> .deploy.lock
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

log() { echo "==> $(date '+%H:%M:%S') $*"; }

# Read KEY=value from .env without sourcing it (sourcing would execute it as bash).
read_var() { grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true; }

PREV_TAG="$(read_var IMAGE_TAG)"
HOST_PORT="$(read_var DOCULEX_HOST_PORT)"
HOST_PORT="${HOST_PORT:-5100}"
IMAGE="$(read_var DOCULEX_IMAGE)"

# Exported: overrides IMAGE_TAG from .env for every compose command below.
export IMAGE_TAG="$NEW_TAG"

health_ok() {
  # "degraded" (LLM provider down) returns 200 too; a deploy demands "ok".
  local body
  for _ in 1 2 3 4 5; do
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:${HOST_PORT}/api/health" || true)"
    if grep -q '"status":"ok"' <<< "$body"; then return 0; fi
    sleep 3
  done
  echo "last health response: ${body:-<none>}" >&2
  return 1
}

log "Deploying $NEW_TAG (running now: ${PREV_TAG:-nothing})"

log "Pulling image"
docker compose pull app

log "Starting database"
docker compose up -d --wait db

log "Running migrations with the new image"
docker compose run --rm --no-deps app node dist/scripts/migrate.js

log "Starting the new version"
if docker compose up -d --wait --wait-timeout 90 app && health_ok; then
  # Record the running version only once it is healthy: this is what the next rollback returns to.
  if grep -q '^IMAGE_TAG=' .env; then
    sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=${NEW_TAG}/" .env
  else
    echo "IMAGE_TAG=${NEW_TAG}" >> .env
  fi
  echo "$(date -Is) ${NEW_TAG}" >> deploy-history.log
  log "Healthy"
else
  log "New version is unhealthy. Last logs:"
  docker compose logs --tail 50 app || true
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$NEW_TAG" ]; then
    log "Rolling back to $PREV_TAG"
    IMAGE_TAG="$PREV_TAG" docker compose up -d --wait --wait-timeout 90 app
  fi
  exit 1
fi

# Keep the 3 newest DocuLex images (the running one and two to roll back to); docker lists newest first.
log "Removing old images"
# Cleanup must not fail a deploy that is already live; docker rmi prints why an image was kept.
docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi || log "some old images were kept"
docker image prune -f > /dev/null

log "Deployed $NEW_TAG"
