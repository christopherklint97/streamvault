# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:26.11.1-trixie-slim@sha256:193fe51b64e77981119c98c2002c9e32a70e2f006fb4d25068ce0558998917f0

## Stage 1: Build frontend; development dependencies never enter runtime.
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
# .dockerignore excludes host installs, secrets and persistent media.
COPY index.html vite.config.ts vitest.config.ts tsconfig*.json ./
COPY build/ build/
COPY scripts/ scripts/
COPY src/ src/
COPY public/ public/
RUN VITE_SERVER_URL="" NODE_OPTIONS="--max-old-space-size=512" nice -n 15 npm run build

## Stage 2: Build Comskip against the same Debian/FFmpeg ABI as runtime.
FROM ${NODE_IMAGE} AS comskip-build
ARG COMSKIP_REV=a140b6ac8bc8f596729e9052819affc779c3b377
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake build-essential ca-certificates git libtool pkg-config \
    libargtable2-dev libavcodec-dev libavfilter-dev libavformat-dev \
    libavutil-dev libpostproc-dev libsdl2-dev libswscale-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --filter=blob:none https://github.com/erikkaashoek/Comskip.git . \
 && git checkout "$COMSKIP_REV" \
 && test "$(git rev-parse HEAD)" = "$COMSKIP_REV" \
 && ./autogen.sh \
 && ./configure \
 && nice -n 15 make -j1

## Stage 3: Emit JS; use tested packaged native prebuilds without install hooks.
FROM ${NODE_IMAGE} AS server-build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig*.json ./
COPY server/src/ src/
COPY server/scripts/ scripts/
ENV TMPDIR=/app/.scratch
RUN mkdir -p "$TMPDIR" \
 && GOMAXPROCS=1 nice -n 15 npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && node scripts/prune-native.mjs \
 && node scripts/smoke-runtime.mjs

## Stage 4: Runtime; keep required recording/live/subtitle capabilities.
FROM ${NODE_IMAGE}
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION
ENV NODE_ENV=production TMPDIR=/app/tmp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libargtable2-0 libsdl2-2.0-0 util-linux python3 python3-av \
 && rm -rf /var/lib/apt/lists/*
RUN /usr/bin/python3 -c 'import av; assert av.__version__'
WORKDIR /app
COPY --from=server-build /app/node_modules node_modules/
COPY --from=server-build /app/dist dist/
COPY --from=server-build /app/scripts/smoke-runtime.mjs scripts/smoke-runtime.mjs
COPY --from=comskip-build /src/comskip /usr/local/bin/comskip
COPY server/package.json ./
COPY server/config/ config/
COPY server/config/comskip/espn.ini /etc/comskip/espn.ini
COPY --from=frontend-build /app/dist public/
RUN mkdir -p /app/data/recordings /app/tmp && chown node:node /app/data /app/data/recordings /app/tmp
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
