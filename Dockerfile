# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0

## Frontend: development dependencies never enter runtime.
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY index.html vite.config.ts vitest.config.ts tsconfig*.json ./
COPY build/ build/
COPY scripts/ scripts/
COPY src/ src/
COPY public/ public/
RUN VITE_SERVER_URL="" NODE_OPTIONS="--max-old-space-size=512" GOMAXPROCS=1 nice -n 15 npm run build
# The bundle inlines these packages; ship their license texts next to it.
RUN node scripts/collect-licenses.mjs /app /app/third-party-licenses

## Pin Debian package resolution for both native build and runtime.
# Bootstrap CA certificates over HTTP with mandatory Debian archive signatures;
# switch the same immutable snapshot URLs to HTTPS immediately afterward.
FROM ${NODE_IMAGE} AS media-base
COPY build/media/debian.env build/media/runtime-packages.txt /tmp/media/
RUN . /tmp/media/debian.env \
 && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf '%s\n' \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT/ trixie main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$DEBIAN_SNAPSHOT/ trixie-security main" \
    > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends $(sed 's/#.*//' /tmp/media/runtime-packages.txt) \
 && /usr/bin/python3 -c 'from pathlib import Path; p=Path("/etc/apt/sources.list"); p.write_text(p.read_text().replace("http://", "https://"))' \
 && rm -rf /var/lib/apt/lists/* /tmp/media

## One shared upstream FFmpeg ABI for ffmpeg/ffprobe, Comskip and source-built PyAV.
FROM media-base AS native-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake build-essential curl gnupg libtool nasm pkg-config \
    python3-dev python3-venv libargtable2-dev \
    libx264-dev libx265-dev libvpx-dev libaom-dev libdav1d-dev libass-dev \
    libgnutls28-dev libfreetype-dev libfontconfig-dev libharfbuzz-dev \
    libmp3lame-dev libopus-dev libvorbis-dev libtheora-dev libwebp-dev \
    libopenjp2-7-dev libsoxr-dev libzimg-dev libzvbi-dev zlib1g-dev liblzma-dev \
 && rm -rf /var/lib/apt/lists/*
COPY build/media/ /build/media/
COPY scripts/build-native-media.sh /build/build-native-media.sh
RUN sh /build/build-native-media.sh fetch
RUN sh /build/build-native-media.sh ffmpeg
# Keep the expensive FFmpeg layer reusable when changing only this API shim.
COPY scripts/comskip-ffmpeg-compat.h scripts/patch-comskip-ffmpeg.py scripts/test-comskip-ffmpeg-compat.c /build/
RUN /usr/bin/python3 /build/patch-comskip-ffmpeg.py /src/Comskip-a140b6ac8bc8f596729e9052819affc779c3b377 \
 && cc -Wall -Wextra -Werror /build/test-comskip-ffmpeg-compat.c \
    -I/opt/media/include -L/opt/media/lib -Wl,-rpath,/opt/media/lib \
    -lavformat -lavcodec -lavutil -lm -o /build/test-comskip-ffmpeg-compat \
 && LD_LIBRARY_PATH=/opt/media/lib /build/test-comskip-ffmpeg-compat \
 && mkdir -p /opt/media/evidence/comskip-compat \
 && cp /build/comskip-ffmpeg-compat.h /build/patch-comskip-ffmpeg.py \
    /build/test-comskip-ffmpeg-compat.c /opt/media/evidence/comskip-compat/
RUN sh /build/build-native-media.sh comskip
RUN sh /build/build-native-media.sh pyav
RUN sh /build/build-native-media.sh bundle

## Emit JS; use tested packaged native prebuilds without install hooks.
FROM ${NODE_IMAGE} AS server-build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig*.json ./
COPY server/src/ src/
COPY server/scripts/ scripts/
ENV TMPDIR=/app/.scratch
RUN mkdir -p "$TMPDIR" \
 && GOMAXPROCS=1 NODE_OPTIONS="--max-old-space-size=512" nice -n 15 npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && node scripts/prune-native.mjs \
 && node scripts/smoke-runtime.mjs

## Non-root compiled runtime: no compiler, distro FFmpeg, pip, or bundled PyAV ABI.
FROM media-base
ARG GIT_REVISION=unknown
# scripts/media-pin-hash.sh; names the corresponding-source bundle (CI sets it).
ARG MEDIA_PIN_HASH=unknown
LABEL org.opencontainers.image.title="StreamVault" \
      org.opencontainers.image.description="Self-hosted IPTV backend and PWA with DVR recording, built on FFmpeg, Comskip and PyAV" \
      org.opencontainers.image.source="https://github.com/christopherklint97/streamvault" \
      org.opencontainers.image.url="https://github.com/christopherklint97/streamvault" \
      org.opencontainers.image.licenses="MIT AND GPL-2.0-or-later" \
      org.opencontainers.image.revision=$GIT_REVISION \
      io.github.christopherklint97.streamvault.source-bundle="ghcr.io/christopherklint97/streamvault-sources:$MEDIA_PIN_HASH"
ENV NODE_ENV=production TMPDIR=/app/tmp \
    PATH=/opt/media/bin:$PATH PYTHONPATH=/opt/media/python \
    COMSKIP_PATH=/opt/media/bin/comskip \
    COMSKIP_REVISION=a140b6ac8bc8f596729e9052819affc779c3b377
COPY --from=native-build /opt/media/ /opt/media/
RUN printf '%s\n' /opt/media/lib > /etc/ld.so.conf.d/streamvault-media.conf \
 && ldconfig
WORKDIR /app
COPY --from=server-build /app/node_modules node_modules/
COPY --from=server-build /app/dist dist/
COPY --from=server-build /app/scripts/smoke-runtime.mjs scripts/smoke-runtime.mjs
COPY scripts/smoke-native-media.py scripts/smoke-native-media.py
COPY server/package.json ./
COPY server/config/ config/
COPY server/config/comskip/espn.ini /etc/comskip/espn.ini
COPY --from=frontend-build /app/dist public/
# License texts, third-party notices and the native build recipe (GPL corresponding
# source pointers). Only tracked, non-secret repository files are copied here.
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/streamvault/
COPY build/media/sources.env build/media/debian.env build/media/runtime-packages.txt \
     build/media/python-build-requirements.txt build/media/ffmpeg-release.asc \
     scripts/build-native-media.sh scripts/comskip-ffmpeg-compat.h scripts/patch-comskip-ffmpeg.py \
     scripts/fetch-media-sources.sh scripts/media-pin-hash.sh /usr/share/doc/streamvault/source/
COPY --from=native-build /opt/media/share/licenses/ /usr/share/doc/streamvault/licenses/
COPY --from=frontend-build /app/third-party-licenses/ /usr/share/doc/streamvault/licenses/frontend/
# Build-context file modes follow the host umask (0600 under umask 077);
# the node user must still be able to read everything copied in.
RUN printf '%s\n' \
      "StreamVault image built from commit $GIT_REVISION" \
      "Source and build recipe: https://github.com/christopherklint97/streamvault/tree/$GIT_REVISION" \
      "" \
      "Media pin hash: $MEDIA_PIN_HASH" \
      "Corresponding source of the GPL/LGPL components (FFmpeg, Comskip, PyAV, Debian source packages):" \
      "  OCI artifact:   ghcr.io/christopherklint97/streamvault-sources:$MEDIA_PIN_HASH" \
      "  GitHub Release: https://github.com/christopherklint97/streamvault/releases/tag/media-sources-$MEDIA_PIN_HASH" \
      "Fetch with:" \
      "  oras pull ghcr.io/christopherklint97/streamvault-sources:$MEDIA_PIN_HASH" \
      "  gh release download media-sources-$MEDIA_PIN_HASH --repo christopherklint97/streamvault" \
      "See THIRD_PARTY_NOTICES.md for components and licenses." \
      > /usr/share/doc/streamvault/SOURCE \
 && chmod -R a+rX /app/scripts /app/config /app/package.json /app/public /etc/comskip /usr/share/doc/streamvault \
 && mkdir -p /app/data/recordings /app/tmp \
 && chown node:node /app/data /app/data/recordings /app/tmp \
 && dpkg-query -W > /opt/media/evidence/runtime-packages.tsv
USER node
RUN /usr/bin/python3 scripts/smoke-native-media.py
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
