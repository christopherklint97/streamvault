#!/bin/bash
set -euo pipefail

# Build, sign, and deploy StreamVault to Samsung TV
# Usage: ./scripts/deploy-tv.sh
# Requires: TV_IP env var, box64, sdb, tizen CLI

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

# Load .env if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

TV_IP="${TV_IP:-}"
APP_ID="StrmVault0.StreamVault"
DEVICE="$TV_IP:26101"
REMOTE_PATH="/home/owner/share/tmp/sdk_tools/StreamVault.wgt"
TIZEN="$HOME/tizen-studio/tools/ide/bin/tizen"
AUTHOR_PASSWORD="${CERT_AUTHOR_PASSWORD:-}"
DIST_PASSWORD="${CERT_DIST_PASSWORD:-}"
AUTHOR_CERT="${CERT_AUTHOR_P12:-$HOME/tizen-studio-data/keystore/author/streamvault-author2.p12}"
DIST_CERT="$HOME/tizen-studio/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.p12"
DIST_CA="$HOME/tizen-studio/tools/certificate-generator/certificates/distributor/tizen-distributor-ca.cer"
PROFILES_XML="$HOME/tizen-studio-data/profile/profiles.xml"

if [ -z "$AUTHOR_PASSWORD" ] || [ -z "$DIST_PASSWORD" ]; then
  echo "Error: CERT_AUTHOR_PASSWORD and CERT_DIST_PASSWORD must be set. Add them to .env."
  exit 1
fi

if [ -z "$TV_IP" ]; then
  echo "Error: TV_IP not set. Add it to .env or export it."
  exit 1
fi

# Step 0: Ensure profiles.xml has inline passwords (Tizen Studio 2025 broke .pwd file support)
echo "Configuring signing profile..."
mkdir -p "$(dirname "$PROFILES_XML")"
cat > "$PROFILES_XML" << XMLEOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<profiles active="StreamVault" version="3.1">
    <profile name="StreamVault">
        <profileitem ca="" distributor="0" key="$AUTHOR_CERT" password="$AUTHOR_PASSWORD" rootca=""/>
        <profileitem ca="$DIST_CA" distributor="1" key="$DIST_CERT" password="$DIST_PASSWORD" rootca=""/>
        <profileitem ca="" distributor="2" key="" password="" rootca=""/>
    </profile>
</profiles>
XMLEOF
"$TIZEN" cli-config "profiles.path=$PROFILES_XML" > /dev/null 2>&1

# Step 1: Build
echo "Building StreamVault..."
npm run build

# Step 2: Sign and package WGT
echo "Signing and packaging WGT..."
"$TIZEN" package -t wgt -s StreamVault -- "$DIST_DIR"

WGT_FILE="$DIST_DIR/StreamVault.wgt"
if [ ! -f "$WGT_FILE" ]; then
  echo "Error: WGT file not found at $WGT_FILE"
  exit 1
fi

# Copy WGT to project root for convenience
cp "$WGT_FILE" "$PROJECT_DIR/StreamVault.wgt"

# Step 3: Connect to TV
echo "Connecting to TV at $TV_IP..."
box64 sdb connect "$TV_IP"

# Step 4: Push WGT
echo "Pushing StreamVault.wgt to TV..."
box64 sdb -s "$DEVICE" push "$WGT_FILE" "$REMOTE_PATH"

# Step 5: Install (uninstall first if cert mismatch)
echo "Installing app..."
INSTALL_OUTPUT=$(box64 sdb -s "$DEVICE" shell 0 vd_appinstall "$APP_ID" "$REMOTE_PATH" 2>&1) || true
echo "$INSTALL_OUTPUT"

if echo "$INSTALL_OUTPUT" | grep -q "Author certificate not match\|certificate error"; then
  echo "Certificate mismatch - uninstalling old version..."
  box64 sdb -s "$DEVICE" shell 0 vd_appuninstall "$APP_ID" || true
  echo "Reinstalling..."
  box64 sdb -s "$DEVICE" shell 0 vd_appinstall "$APP_ID" "$REMOTE_PATH"
fi

# Step 6: Launch
echo "Launching app..."
box64 sdb -s "$DEVICE" shell 0 was_launch "$APP_ID"

echo "Done! StreamVault should be running on your TV."
