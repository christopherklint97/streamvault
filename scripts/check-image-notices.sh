#!/usr/bin/env bash
# The image must carry its license texts, third-party notices and build recipe,
# the license label, and name its GPL corresponding-source bundle (label and
# /usr/share/doc/streamvault/SOURCE).
#   bash scripts/check-image-notices.sh IMAGE [EXPECTED_REVISION] [EXPECTED_MEDIA_PIN_HASH]
set -euo pipefail
image=${1:?Usage: scripts/check-image-notices.sh IMAGE [EXPECTED_REVISION] [EXPECTED_MEDIA_PIN_HASH]}
revision=${2:-}
pin=${3:-}
bundle_label=io.github.christopherklint97.streamvault.source-bundle

licenses=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.licenses" }}' "$image")
[ "$licenses" = "MIT AND GPL-2.0-or-later" ] || { echo "license label is '$licenses'" >&2; exit 1; }
bundle=$(docker image inspect --format "{{ index .Config.Labels \"$bundle_label\" }}" "$image")
echo "$bundle_label=$bundle"
if [ -n "$pin" ]; then
	[ "$bundle" = "ghcr.io/christopherklint97/streamvault-sources:$pin" ] ||
		{ echo "$bundle_label does not name media pin $pin" >&2; exit 1; }
fi

docker run --rm --entrypoint /bin/sh "$image" -ec '
	d=/usr/share/doc/streamvault
	for f in LICENSE THIRD_PARTY_NOTICES.md SOURCE \
		licenses/COPYING.GPLv2 licenses/LICENSE.md licenses/Comskip-LICENSE licenses/PyAV-LICENSE \
		licenses/frontend/INDEX.tsv \
		source/build-native-media.sh source/sources.env source/debian.env source/runtime-packages.txt \
		source/python-build-requirements.txt source/ffmpeg-release.asc source/comskip-ffmpeg-compat.h \
		source/patch-comskip-ffmpeg.py source/fetch-media-sources.sh source/media-pin-hash.sh; do
		test -s "$d/$f" || { echo "missing $d/$f" >&2; exit 1; }
	done
	if [ -n "$1" ]; then grep -q "$1" "$d/SOURCE"; fi
	if [ -n "$2" ]; then
		grep -qF "Media pin hash: $2" "$d/SOURCE"
		grep -qF "ghcr.io/christopherklint97/streamvault-sources:$2" "$d/SOURCE"
		grep -qF "https://github.com/christopherklint97/streamvault/releases/tag/media-sources-$2" "$d/SOURCE"
	fi
	cat "$d/SOURCE"
	wc -l < "$d/licenses/frontend/INDEX.tsv" | xargs printf "frontend packages listed: %s rows\n"
' check "$revision" "$pin"
