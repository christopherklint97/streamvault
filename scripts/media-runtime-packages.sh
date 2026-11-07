#!/usr/bin/env bash
# Install build/media/runtime-packages.txt from the pinned Debian snapshot into
# the pinned base image, the way the Dockerfile's media-base stage does, and
# print (TSV) every package apt added or changed on top of the base image, with
# its source package and the GPL-family licenses its Debian copyright file
# names ("-" for none). build-source-bundle.sh ships the Debian source of every
# package with a GPL/LGPL entry. Runs one container of the native architecture.
#
#   scripts/media-runtime-packages.sh > runtime-packages-$(dpkg --print-architecture).tsv
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
base=$(sed -n 's/^ARG NODE_IMAGE=//p' "$root/Dockerfile")
[ -n "$base" ] || { echo "no ARG NODE_IMAGE= in $root/Dockerfile" >&2; exit 1; }

docker run --rm -i --network bridge -v "$root/build/media:/media:ro" "$base" /bin/sh -s <<'EOF'
set -eu
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
. /media/debian.env
rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
printf '%s\n' \
	"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT/ trixie main" \
	"deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$DEBIAN_SNAPSHOT/ trixie-security main" \
	> /etc/apt/sources.list
fmt='${Package}\t${Version}\n'
dpkg-query -W -f "$fmt" | sort > /tmp/before
apt-get update -qq >&2
# shellcheck disable=SC2046
apt-get install -qq -y --no-install-recommends $(sed 's/#.*//' /media/runtime-packages.txt) >&2
dpkg-query -W -f "$fmt" | sort | comm -13 /tmp/before - | cut -f1 > /tmp/added
arch=$(dpkg --print-architecture)
printf 'arch\tpackage\tversion\tsource\tsource_version\tgpl_licenses\n'
while read -r pkg; do
	info=$(dpkg-query -W -f '${Version}\t${source:Package}\t${source:Version}' "$pkg")
	copyright=/usr/share/doc/$pkg/copyright
	if [ ! -s "$copyright" ]; then
		gpl='(no copyright file)'
	elif grep -q '^Format:' "$copyright"; then
		# DEP-5: every distinct GPL/LGPL/AGPL License: name.
		gpl=$(sed -n 's/^License:[[:space:]]*//p' "$copyright" | grep 'GPL' | sed 's/[[:space:]]*$//' | sort -u | paste -sd ';' -)
	elif grep -qiE 'GNU (Lesser |Library |Affero )?General Public License|[^A-Za-z]L?GPL' "$copyright"; then
		gpl='GPL family (free-form copyright file)'
	else
		gpl=
	fi
	printf '%s\t%s\t%s\t%s\n' "$arch" "$pkg" "$info" "${gpl:--}"
done < /tmp/added
EOF
