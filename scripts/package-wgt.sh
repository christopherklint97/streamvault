#!/bin/bash
set -euo pipefail

# Build and package StreamVault as a Tizen .wgt file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"
WGT_FILE="$PROJECT_DIR/StreamVault.wgt"

echo "Building StreamVault..."
cd "$PROJECT_DIR"
npm run build

echo "Packaging .wgt..."
cd "$DIST_DIR"

# Remove old .wgt if exists
rm -f "$WGT_FILE"

# Create .wgt (ZIP file with .wgt extension)
zip -r "$WGT_FILE" . -x '*.map'

echo "Package created: $WGT_FILE"
ls -lh "$WGT_FILE"
