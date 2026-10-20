#!/bin/bash
# Doculex deployment script — runs ON the COVER VPS (called by GitLab CI).
# Usage: DEPLOY_BRANCH=<branch> DEPLOY_PATH=<path> [BUILD_ASSETS=1] bash deploy.sh
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-/home/cover/web/projects/doculex}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"

cd "$DEPLOY_PATH"

echo "==> Begin Deployment..."
echo "==> Updating code to origin/$DEPLOY_BRANCH..."
git fetch origin "$DEPLOY_BRANCH"
git checkout "$DEPLOY_BRANCH"
# The server must mirror the repository exactly; local edits are discarded.
git reset --hard "origin/$DEPLOY_BRANCH"

echo "==> Installing node dependencies..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use --silent default >/dev/null
npm install --force --no-audit --no-fund

trap - ERR
echo "==> Error installing node dependencies..."

npm run build

trap - ERR
echo "==> Error building application..."

echo "==> Running database migrations..."
npm run db:migrate

trap - ERR
echo "==> Error running migrations..."

echo "==> Restarting background services (supervisor)..."
# Requires a sudoers rule allowing this user to run supervisorctl without a password.
sudo -n /usr/bin/supervisorctl restart 'doculex:*'

trap - ERR
echo "==> Error during deployment..."

echo "==> Deployment finished successfully! ($(git rev-parse --short HEAD))"
