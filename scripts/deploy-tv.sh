#!/bin/bash
set -euo pipefail

# Deploy StreamVault to Samsung TV via SDB
TV_IP="${TV_IP:-}"
WGT_FILE="StreamVault.wgt"
APP_ID="Streamvault.StreamVault"

if [ -z "$TV_IP" ]; then
  echo "Usage: TV_IP=192.168.x.x ./scripts/deploy-tv.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WGT_PATH="$PROJECT_DIR/$WGT_FILE"

if [ ! -f "$WGT_PATH" ]; then
  echo "Error: $WGT_FILE not found. Run scripts/package-wgt.sh first."
  exit 1
fi

echo "Connecting to TV at $TV_IP..."
sdb connect "$TV_IP"

echo "Installing $WGT_FILE..."
sdb -s "$TV_IP:26101" install "$WGT_PATH"

echo "Launching app..."
sdb -s "$TV_IP:26101" shell 0 was_launch "$APP_ID"

echo "Done! StreamVault should be running on your TV."
