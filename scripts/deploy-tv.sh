#!/bin/bash
set -euo pipefail

# Deploy StreamVault to Samsung TV via SDB
# Downloads the latest signed WGT from GitHub Actions, then pushes to TV.
# Usage: ./scripts/deploy-tv.sh
# Requires: TV_IP env var, sdb, gh CLI

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

TV_IP="${TV_IP:-}"
APP_ID="Streamvault.StreamVault"
DEVICE="$TV_IP:26101"
REMOTE_PATH="/home/owner/share/tmp/sdk_tools/StreamVault.wgt"
WGT_PATH="$PROJECT_DIR/StreamVault.wgt"
REPO="christopherklint97/streamvault"

if [ -z "$TV_IP" ]; then
  echo "Error: TV_IP not set. Add it to .env or export it."
  exit 1
fi

# Step 1: Download latest signed WGT from GitHub Actions
echo "Downloading latest signed WGT from GitHub Actions..."
gh run download --repo "$REPO" --name StreamVault-signed --dir "$PROJECT_DIR/artifact-tmp" 2>&1 || {
  echo "Error: Could not download artifact. Check that the GitHub Action has run successfully."
  echo "  gh run list --repo $REPO --workflow build-deploy.yml"
  exit 1
}

mv "$PROJECT_DIR/artifact-tmp/StreamVault.wgt" "$WGT_PATH"
rm -rf "$PROJECT_DIR/artifact-tmp"
echo "Downloaded: $WGT_PATH"

# Step 2: Connect to TV
echo "Connecting to TV at $TV_IP..."
sdb connect "$TV_IP"

# Step 3: Push WGT
echo "Pushing StreamVault.wgt to TV..."
sdb -s "$DEVICE" push "$WGT_PATH" "$REMOTE_PATH"

# Step 4: Install
echo "Installing app..."
sdb -s "$DEVICE" shell 0 vd_appinstall "$APP_ID" "$REMOTE_PATH"

# Step 5: Launch
echo "Launching app..."
sdb -s "$DEVICE" shell 0 was_launch "$APP_ID"

echo "Done! StreamVault should be running on your TV."
