#!/bin/bash
set -euo pipefail

# Build, sign, and deploy StreamVault to Samsung TV
# Usage: ./scripts/deploy-tv.sh
# Requires: TV_IP env var, box64, sdb, tizen CLI, python3 with pexpect

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

if [ -z "$AUTHOR_PASSWORD" ] || [ -z "$DIST_PASSWORD" ]; then
  echo "Error: CERT_AUTHOR_PASSWORD and CERT_DIST_PASSWORD must be set. Add them to .env."
  exit 1
fi

if [ -z "$TV_IP" ]; then
  echo "Error: TV_IP not set. Add it to .env or export it."
  exit 1
fi

# Step 1: Build
echo "Building StreamVault..."
npm run build

# Step 2: Sign and package WGT using tizen CLI via pexpect
# Handles password prompts if not saved, or runs straight through if saved
echo "Signing and packaging WGT..."
PYTHONPATH=/usr/lib/python3/dist-packages python3 << PYEOF
import pexpect, sys

child = pexpect.spawn(
    '${TIZEN} package -t wgt -s StreamVault -- ${DIST_DIR}',
    timeout=60
)
child.logfile_read = sys.stdout.buffer

while True:
    i = child.expect([
        'Author password:',
        'Distributor1 password:',
        r'Yes:.*No:.*\?',
        'Package File Location:',
        'error',
        pexpect.EOF,
        pexpect.TIMEOUT
    ], timeout=30)
    if i == 0:
        child.sendline('${AUTHOR_PASSWORD}')
    elif i == 1:
        child.sendline('${DIST_PASSWORD}')
    elif i == 2:
        child.sendline('N')
    elif i == 3:
        # Success - wait for EOF
        child.expect(pexpect.EOF, timeout=5)
        break
    elif i >= 4:
        break

child.close()
if child.exitstatus and child.exitstatus != 0:
    print(f"\nSigning failed with exit code {child.exitstatus}")
    sys.exit(child.exitstatus)
PYEOF

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
