#!/usr/bin/env bash
# Print the media pin hash: 16 hex digits identifying everything the GPL
# corresponding-source bundle is made from. Images built from the same pin set
# share one bundle, ghcr.io/christopherklint97/streamvault-sources:<hash> and
# the GitHub Release media-sources-<hash>.
#
# The pin set: build/media/* (upstream archive pins, Debian snapshot, runtime
# Debian package list, Python build lock, FFmpeg release key), the native build
# script, the Comskip compatibility shim and patch files, the bundle scripts,
# and the pinned Node/Debian base image (it decides which Debian packages apt
# adds on top).
#
#   scripts/media-pin-hash.sh [REPO_ROOT]
set -euo pipefail
export LC_ALL=C
root=${1:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$root"
base=$(sed -n 's/^ARG NODE_IMAGE=//p' Dockerfile)
[ -n "$base" ] || { echo "no ARG NODE_IMAGE= in $root/Dockerfile" >&2; exit 1; }
{
	sha256sum build/media/* \
		scripts/build-native-media.sh scripts/comskip-ffmpeg-compat.h \
		scripts/patch-comskip-ffmpeg.py scripts/test-comskip-ffmpeg-compat.c \
		scripts/fetch-media-sources.sh scripts/media-runtime-packages.sh \
		scripts/build-source-bundle.sh
	printf 'NODE_IMAGE=%s\n' "$base"
} | sha256sum | cut -c1-16
