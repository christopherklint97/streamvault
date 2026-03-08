FROM node:24-slim AS build

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim

WORKDIR /app

COPY --from=build /app/node_modules node_modules/
COPY package.json ./
COPY src/ src/

EXPOSE 3001

CMD ["node", "--import", "tsx", "src/index.ts"]
