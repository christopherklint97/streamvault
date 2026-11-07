#!/usr/bin/env bash
# Stage the GPL corresponding source of the image's native media stack:
# the exact upstream archives scripts/build-native-media.sh builds (same URLs,
# same SHA-256 pins from build/media/sources.env, same FFmpeg signature check),
# plus the local Comskip patch shim and the build recipe. Part of the source
# bundle that scripts/build-source-bundle.sh assembles (it adds the Debian
# source packages); this alone does not need Docker.
#
#   scripts/fetch-media-sources.sh OUTDIR
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?Usage: scripts/fetch-media-sources.sh OUTDIR}
mkdir -p "$out"
out=$(cd "$out" && pwd)

# shellcheck source=../build/media/sources.env
. "$root/build/media/sources.env"

fetch() {
	curl --fail --location --retry 3 --proto '=https' --tlsv1.2 -sS "$1" -o "$out/$2"
	if [ -n "${3:-}" ]; then
		(cd "$out" && printf '%s  %s\n' "$3" "$2" | sha256sum --check --strict -)
	fi
}

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256"
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz.asc" "ffmpeg-$FFMPEG_VERSION.tar.xz.asc"
gnupg=$(mktemp -d)
trap 'rm -rf "$gnupg"' EXIT
GNUPGHOME=$gnupg gpg --batch --quiet --import "$root/build/media/ffmpeg-release.asc"
GNUPGHOME=$gnupg gpg --batch --status-fd 1 --verify \
	"$out/ffmpeg-$FFMPEG_VERSION.tar.xz.asc" "$out/ffmpeg-$FFMPEG_VERSION.tar.xz" 2>/dev/null |
	grep -q "^\[GNUPG:\] VALIDSIG $FFMPEG_SIGNING_FINGERPRINT " ||
	{ echo "FFmpeg signature does not verify against $FFMPEG_SIGNING_FINGERPRINT" >&2; exit 1; }
fetch "$PYAV_URL" "av-$PYAV_VERSION.tar.gz" "$PYAV_SHA256"
fetch "https://codeload.github.com/erikkaashoek/Comskip/tar.gz/$COMSKIP_REVISION" \
	"Comskip-$COMSKIP_REVISION.tar.gz" "$COMSKIP_SHA256"

# Build recipe and the local Comskip modification (applied by the Dockerfile).
cp "$root/Dockerfile" "$root/LICENSE" "$root/THIRD_PARTY_NOTICES.md" \
	"$root/build/media/sources.env" "$root/build/media/python-build-requirements.txt" \
	"$root/build/media/ffmpeg-release.asc" "$root/scripts/build-native-media.sh" \
	"$root/scripts/comskip-ffmpeg-compat.h" "$root/scripts/patch-comskip-ffmpeg.py" \
	"$root/scripts/test-comskip-ffmpeg-compat.c" "$out/"

(cd "$out" && rm -f SHA256SUMS && sha256sum -- * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS)
echo "Corresponding source staged in $out"
