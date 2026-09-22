## Stage 1: Build frontend
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239 AS frontend-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig*.json ./
COPY src/ src/
COPY public/ public/

# Build with empty server URL so frontend uses relative /api paths
RUN VITE_SERVER_URL="" npm run build

## Stage 2: Build Comskip for ARM64/AMD64
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239 AS comskip-build

ARG COMSKIP_REV=a140b6a
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake build-essential ca-certificates git libtool pkg-config \
    libargtable2-dev libavcodec-dev libavfilter-dev libavformat-dev \
    libavutil-dev libpostproc-dev libsdl2-dev libswscale-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --filter=blob:none https://github.com/erikkaashoek/Comskip.git . \
 && git checkout "$COMSKIP_REV" \
 && test "$(git rev-parse --short HEAD)" = "$COMSKIP_REV" \
 && ./autogen.sh \
 && ./configure \
 && make -j2

## Stage 3: Build server native deps
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239 AS server-build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

## Stage 4: Runtime
FROM node:26-slim@sha256:14bf3eac4bf209d906d3c41256597d3ab1f926b2e93a79e9bdfe1efd32454239

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libargtable2-0 libsdl2-2.0-0 util-linux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=server-build /app/node_modules node_modules/
COPY --from=comskip-build /src/comskip /usr/local/bin/comskip
COPY server/package.json ./
COPY server/src/ src/
COPY server/config/ config/
COPY server/config/comskip/espn.ini /etc/comskip/espn.ini

# Copy built frontend into server's public directory
COPY --from=frontend-build /app/dist public/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/index.ts"]
