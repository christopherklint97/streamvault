#!/usr/bin/env bash
# Assemble the GPL corresponding-source bundle for the current media pin set
# (scripts/media-pin-hash.sh) in OUTDIR:
#   - the exact FFmpeg (with its .asc signature), Comskip and PyAV archives,
#     the Comskip compatibility shim and patch script, the native build script,
#     the Dockerfile and the pin files (scripts/fetch-media-sources.sh);
#   - debian-sources.tar: the Debian source packages (.dsc, orig and debian
#     tarballs) of every runtime package whose Debian copyright file names a
#     GPL/LGPL license, fetched from the pinned snapshot with apt-get source
#     (Release signatures and file hashes are checked by apt);
#   - debian-packages.tsv: every Debian package apt adds to the runtime image,
#     per architecture, with its source package and GPL-family licenses;
#   - SHA256SUMS.
# Each PACKAGES_TSV is the output of scripts/media-runtime-packages.sh for one
# architecture. Every file must stay under GitHub's 2 GiB release-asset limit.
#
#   scripts/build-source-bundle.sh OUTDIR PACKAGES_TSV...
set -euo pipefail
export LC_ALL=C
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?Usage: scripts/build-source-bundle.sh OUTDIR PACKAGES_TSV...}
shift
[ "$#" -gt 0 ] || { echo "Usage: scripts/build-source-bundle.sh OUTDIR PACKAGES_TSV..." >&2; exit 1; }
mkdir -p "$out"
out=$(cd "$out" && pwd)
base=$(sed -n 's/^ARG NODE_IMAGE=//p' "$root/Dockerfile")
# shellcheck source=../build/media/sources.env
. "$root/build/media/sources.env"

"$root/scripts/fetch-media-sources.sh" "$out"
cp "$root/build/media/debian.env" "$root/build/media/runtime-packages.txt" \
	"$root/scripts/media-pin-hash.sh" "$root/scripts/media-runtime-packages.sh" \
	"$root/scripts/build-source-bundle.sh" "$out/"
"$root/scripts/media-pin-hash.sh" "$root" > "$out/MEDIA_PIN_HASH"

# One table for all architectures; the header comes from the first file.
{ head -n1 "$1"; for f in "$@"; do tail -n +2 "$f"; done | sort -u; } > "$out/debian-packages.tsv"
awk -F'\t' 'NR > 1 && $6 != "-" { print $4 "=" $5 }' "$out/debian-packages.tsv" | sort -u > "$out/debian-sources.txt"
[ -s "$out/debian-sources.txt" ] || { echo "no GPL/LGPL Debian packages found" >&2; exit 1; }
echo "Debian source packages: $(wc -l < "$out/debian-sources.txt")"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
docker run --rm -i -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
	-e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
	-v "$root/build/media:/media:ro" -v "$out:/out" -v "$work:/work" "$base" /bin/sh -s <<'EOF'
set -eu
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
. /media/debian.env
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
for kind in deb deb-src; do
	printf '%s\n' \
		"$kind [check-valid-until=no] http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT/ trixie main" \
		"$kind [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$DEBIAN_SNAPSHOT/ trixie-security main"
done > /etc/apt/sources.list
apt-get update -qq
mkdir -p /work/debian-sources
cd /work/debian-sources
# shellcheck disable=SC2046
apt-get source -qq --download-only --only-source -o APT::Sandbox::User=root $(cat /out/debian-sources.txt)
# Each requested source must have produced its .dsc (no epoch in file names).
while IFS== read -r src ver; do
	dsc="${src}_${ver#*:}.dsc"
	[ -s "$dsc" ] || { echo "missing $dsc" >&2; exit 1; }
done < /out/debian-sources.txt
sha256sum -- * > SHA256SUMS
cp /out/debian-packages.tsv /out/debian-sources.txt .
cd /work
tar --sort=name --format=gnu --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
	--mode=a+rX,u+w,go-w -cf /out/debian-sources.tar debian-sources
chown "$HOST_UID:$HOST_GID" /out/debian-sources.tar
rm -rf /work/debian-sources
EOF

cd "$out"
rm -f SHA256SUMS
sha256sum -- * > SHA256SUMS.tmp
mv SHA256SUMS.tmp SHA256SUMS
limit=$((2 * 1024 * 1024 * 1024))
total=0
for f in *; do
	size=$(stat -c %s "$f")
	total=$((total + size))
	[ "$size" -lt "$limit" ] || { echo "$f is $size bytes, over the 2 GiB release-asset limit" >&2; exit 1; }
done
ls -l
set -- *
echo "Bundle for media pin $(cat MEDIA_PIN_HASH): $# files, $total bytes ($((total / 1024 / 1024)) MiB)"
