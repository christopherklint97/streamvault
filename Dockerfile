## Stage 1: Build frontend
FROM node:24-slim AS frontend-build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig*.json ./
COPY src/ src/
COPY public/ public/

# Build with empty server URL so frontend uses relative /api paths
RUN VITE_SERVER_URL="" npx vite build

## Stage 2: Build server native deps
FROM node:24-slim AS server-build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

## Stage 3: Runtime
FROM node:24-slim

WORKDIR /app

COPY --from=server-build /app/node_modules node_modules/
COPY server/package.json ./
COPY server/src/ src/

# Copy built frontend into server's public directory
COPY --from=frontend-build /app/dist public/

EXPOSE 3001

CMD ["node", "--import", "tsx", "src/index.ts"]
