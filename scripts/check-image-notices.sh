#!/usr/bin/env bash
# The image must carry its license texts, third-party notices and build recipe.
#   bash scripts/check-image-notices.sh IMAGE [EXPECTED_REVISION]
set -euo pipefail
image=${1:?Usage: scripts/check-image-notices.sh IMAGE [EXPECTED_REVISION]}
revision=${2:-}
docker run --rm --entrypoint /bin/sh "$image" -ec '
	d=/usr/share/doc/streamvault
	for f in LICENSE THIRD_PARTY_NOTICES.md SOURCE \
		licenses/COPYING.GPLv2 licenses/LICENSE.md licenses/Comskip-LICENSE licenses/PyAV-LICENSE \
		licenses/frontend/INDEX.tsv \
		source/build-native-media.sh source/sources.env source/python-build-requirements.txt \
		source/ffmpeg-release.asc source/comskip-ffmpeg-compat.h source/patch-comskip-ffmpeg.py \
		source/fetch-media-sources.sh; do
		test -s "$d/$f" || { echo "missing $d/$f" >&2; exit 1; }
	done
	if [ -n "$1" ]; then grep -q "$1" "$d/SOURCE"; fi
	cat "$d/SOURCE"
	wc -l < "$d/licenses/frontend/INDEX.tsv" | xargs printf "frontend packages listed: %s rows\n"
' check "$revision"
