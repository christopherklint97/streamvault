#!/bin/sh
# Run only in the disposable native-build stage. Never use distro libav headers.
set -eu
. /build/media/sources.env
export SOURCE_DATE_EPOCH PYTHONHASHSEED=0
export PKG_CONFIG_PATH=/opt/media/lib/pkgconfig
export LD_LIBRARY_PATH=/opt/media/lib
fetch() {
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 "$1" -o "$2"
    printf '%s  %s\n' "$3" "$2" | sha256sum --check --strict -
}
case "${1:?fetch|ffmpeg|comskip|pyav|bundle}" in
fetch)
    mkdir -p /src /opt/media/share/licenses /opt/media/evidence
    cd /src
    fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" ffmpeg.tar.xz "$FFMPEG_SHA256"
    curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
        "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz.asc" -o ffmpeg.tar.xz.asc
    export GNUPGHOME=/src/gnupg
    mkdir -m 700 "$GNUPGHOME"
    gpg --batch --import /build/media/ffmpeg-release.asc
    gpg --batch --with-colons --fingerprint "$FFMPEG_SIGNING_FINGERPRINT" > /opt/media/evidence/ffmpeg-key.txt
    gpg --batch --status-fd 1 --verify ffmpeg.tar.xz.asc ffmpeg.tar.xz > /opt/media/evidence/ffmpeg-signature.txt
    grep -q "^\[GNUPG:\] VALIDSIG $FFMPEG_SIGNING_FINGERPRINT " /opt/media/evidence/ffmpeg-signature.txt
    fetch "$PYAV_URL" pyav.tar.gz "$PYAV_SHA256"
    fetch "https://codeload.github.com/erikkaashoek/Comskip/tar.gz/$COMSKIP_REVISION" comskip.tar.gz "$COMSKIP_SHA256"
    tar -xf ffmpeg.tar.xz
    tar -xf pyav.tar.gz
    tar -xf comskip.tar.gz
    cp /build/media/sources.env /opt/media/evidence/sources.env
    cp /build/media/python-build-requirements.txt /opt/media/evidence/python-build-requirements.txt
    cp /build/media/ffmpeg-release.asc /opt/media/evidence/
    cp ffmpeg.tar.xz.asc /opt/media/evidence/
    ;;
ffmpeg)
    cd "/src/ffmpeg-$FFMPEG_VERSION"
    # Keep all built-in decoders, encoders, muxers, protocols, filters and BSFs.
    # External libraries cover browser transcoding, HEVC/AV1/VPx, subtitles,
    # HTTPS, teletext, and ordinary audio/image input. No nonfree libraries.
    nice -n 15 ./configure --prefix=/opt/media --enable-shared --disable-static \
        --disable-debug --disable-doc --disable-ffplay --enable-gpl \
        --enable-gnutls --enable-libx264 --enable-libx265 --enable-libvpx \
        --enable-libaom --enable-libdav1d --enable-libass --enable-libfreetype \
        --enable-libfontconfig --enable-libharfbuzz --enable-libmp3lame \
        --enable-libopus --enable-libvorbis --enable-libtheora --enable-libwebp \
        --enable-libopenjpeg --enable-libsoxr --enable-libzimg --enable-libzvbi
    nice -n 15 make -j1
    nice -n 15 make install
    cp config.h ffbuild/config.mak /opt/media/evidence/
    cp COPYING.GPLv2 LICENSE.md /opt/media/share/licenses/
    ;;
comskip)
    cd "/src/Comskip-$COMSKIP_REVISION"
    ./autogen.sh
    ./configure --prefix=/opt/media --disable-gui
    nice -n 15 make -j1
    install -m 755 comskip /opt/media/bin/comskip
    cp LICENSE /opt/media/share/licenses/Comskip-LICENSE
    ;;
pyav)
    /usr/bin/python3 -m venv /opt/build-python
    /opt/build-python/bin/python -m pip install --only-binary=:all: --require-hashes \
        -r /build/media/python-build-requirements.txt
    # Explicit source archive + no build isolation/deps: never a bundled libav wheel.
    nice -n 15 /opt/build-python/bin/python -m pip wheel --no-build-isolation --no-deps \
        --wheel-dir /src/wheels "/src/av-$PYAV_VERSION"
    /opt/build-python/bin/python -m pip install --no-deps --no-compile \
        --target=/opt/media/python /src/wheels/av-*.whl
    cp "/src/av-$PYAV_VERSION/LICENSE.txt" /opt/media/share/licenses/PyAV-LICENSE
    ;;
bundle)
    export FFMPEG_VERSION PYAV_VERSION COMSKIP_REVISION
    /usr/bin/python3 -c 'import json,os; from pathlib import Path; Path("/opt/media/manifest.json").write_text(json.dumps({"ffmpeg":os.environ["FFMPEG_VERSION"],"pyav":os.environ["PYAV_VERSION"],"comskip_revision":os.environ["COMSKIP_REVISION"],"source_date_epoch":os.environ["SOURCE_DATE_EPOCH"]},indent=2)+"\n")'
    dpkg-query -W > /opt/media/evidence/build-packages.tsv
    rm -rf /opt/media/include /opt/media/lib/pkgconfig /opt/media/share/man
    ;;
*) exit 2 ;;
esac
