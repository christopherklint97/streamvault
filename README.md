# StreamVault

IPTV streaming app for Samsung Tizen smart TVs and mobile PWA. Built with Preact's React-compatible renderer, TypeScript 7, and Vite, with a Node.js backend server.

Toolchain and upgrade notes: [frontend compiler/renderer](docs/frontend-toolchain.md) and [production runtime, compression, and existing-volume migration](docs/dependency-runtime.md).

## Backend required

StreamVault is not a standalone TV player. The Tizen widget is a frontend and
requires the StreamVault backend to run on another device such as a PC, NAS,
Raspberry Pi, Proxmox guest, or server. Installing a `.wgt`, including through
Apps2Samsung, does not install that backend. The StreamVault backend URL is
separate from the Xtream server URL supplied by an IPTV provider.

Start the backend on a Docker host with the prebuilt image (see
[Run with Docker](#run-with-docker)):

```bash
git clone https://github.com/christopherklint97/streamvault.git
cd streamvault
docker compose pull
docker compose up -d
```

Verify it from another device on the same network, replacing `<backend-ip>`
with the Docker host's LAN address:

```bash
curl --fail http://<backend-ip>:3002/api/health
```

In the TV app, open **Settings**, enter `http://<backend-ip>:3002` under
**StreamVault Server URL**, and select **Connect**. Enter the provider's Xtream
server URL and credentials only after the backend connection succeeds. Backend
logs are available on the Docker host:

```bash
docker compose logs -f server
```

## Run with Docker

CI publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to
`ghcr.io/christopherklint97/streamvault`. Each image is built natively per
architecture from the same commit and published only after lint, unit tests and
the packaged-runtime smoke tests pass on both architectures.

```bash
git clone https://github.com/christopherklint97/streamvault.git
cd streamvault
# Optional: pick a tag (default :latest, the newest release).
echo 'STREAMVAULT_IMAGE=ghcr.io/christopherklint97/streamvault:latest' >> .env
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:3002/api/health
```

Update with `docker compose pull && docker compose up -d`. Data lives in the
`streamvault_data` and `streamvault_recordings` volumes and survives updates.
To build from source instead, set `STREAMVAULT_IMAGE` to a local name such as
`streamvault:local` and run `docker compose up -d --build`.

| Tag | Meaning |
| --- | --- |
| `latest` | Newest `vX.Y.Z` release |
| `X.Y.Z`, `X.Y` | A release, and the newest patch of a minor release |
| `edge` | Newest green commit on `main` |
| `sha-<full commit sha>` | One specific green commit on `main` (used by the Pi deploy script) |

`latest` exists only after the first `v*` release tag; until then use `edge`.

### Verify the image

Every published manifest has a GitHub build-provenance attestation, a keyless
Sigstore (cosign) signature, and per-architecture SBOM and provenance from
BuildKit.

```bash
# Build provenance (gh >= 2.49): built by this repo's CI workflow
gh attestation verify oci://ghcr.io/christopherklint97/streamvault:edge \
  --owner christopherklint97

# Cosign signature
cosign verify ghcr.io/christopherklint97/streamvault:edge \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/christopherklint97/streamvault/\.github/workflows/ci\.yml@refs/(heads/main|tags/v.+)$'

# SBOM (SPDX) for one architecture
docker buildx imagetools inspect ghcr.io/christopherklint97/streamvault:edge \
  --format '{{ json (index .SBOM "linux/arm64").SPDX }}'
```

### Source code and licenses

StreamVault is MIT-licensed. The image is labelled `MIT AND GPL-2.0-or-later`
because it also contains FFmpeg built with x264/x265 (GPL-2.0-or-later), a
patched Comskip (GPL-2.0), PyAV and Debian libraries. [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) lists the
components, versions, licenses and source URLs; inside the image it is in
`/usr/share/doc/streamvault/` with the license texts and the native build
recipe.

Corresponding source: every image names a source bundle that holds the exact
FFmpeg (with its signature), Comskip and PyAV source archives, the Comskip
patch shim, the build script, the Dockerfile, the Debian source packages of the
GPL/LGPL Debian libraries in the image, and `SHA256SUMS`. It is published next
to the image, as the OCI artifact
`ghcr.io/christopherklint97/streamvault-sources:<pin>` and as the pre-release
`media-sources-<pin>` on the
[Releases](https://github.com/christopherklint97/streamvault/releases) page.
`<pin>` is in the image's `io.github.christopherklint97.streamvault.source-bundle`
label and in `/usr/share/doc/streamvault/SOURCE`; CI does not publish an image
before its bundle exists.

```bash
image=ghcr.io/christopherklint97/streamvault:latest
bundle=$(docker buildx imagetools inspect --raw "$image" |
  jq -r '.annotations["io.github.christopherklint97.streamvault.source-bundle"]')
pin=${bundle##*:}
mkdir "sources-$pin" && cd "sources-$pin"
oras pull "$bundle"   # or: gh release download "media-sources-$pin" --repo christopherklint97/streamvault
sha256sum --check SHA256SUMS
```

## Features

- **Live TV, Movies, Series** - Browse and play via Xtream Codes API or M3U playlists
- **Movie detail pages** - View poster, plot, rating, cast before playing
- **Series detail** - Season/episode browser with per-episode watch progress
- **Mobile PWA** - Installable progressive web app with touch-optimized UI
- **Mobile player** - Swipe-to-scrub, double-tap skip, auto Picture-in-Picture when leaving app
- **Live TV list view** - Clean, text-only list for live channels (no images, full titles visible)
- **Favorites** - Favorite any content; create custom named lists to organize items
- **Watch progress** - Continue Watching and Resume support across all content types
- **D-pad/remote navigation** - Full Tizen TV remote control support
- **EPG** - On-demand Electronic Program Guide per stream
- **Search** - Server-side search across all content types
- **Recordings** - Schedule, play back, and manage recorded streams
- **Hardened local API** - Optional token auth, masked credentials, SSRF-safe stream proxying, and health checks

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 8, Zustand 5
- **Backend**: Node.js, Express, better-sqlite3
- **Testing**: Vitest
- **Deployment**: Docker, Tizen TV CLI

## Architecture

```
src/
  components/   # Player, ChannelList, ChannelCard, MovieDetail, SeriesDetail, Sidebar, etc.
  stores/       # Zustand stores (channelStore, favoritesStore, playerStore, appStore)
  hooks/        # useFocusNavigation, useRemoteKeys, usePlayer, useNetworkStatus
  services/     # EPG service, channel service, AVPlay wrapper
  pages/        # Home, Settings
  types.ts      # Core type definitions
server/
  src/          # Express API, SQLite DB, Xtream client, sync engine
scripts/        # Tizen signing, packaging, and deployment
```

## Development

```bash
npm install
npm run dev       # Start frontend dev server
npm run build     # Web PWA (root-relative assets)
npm run build:wgt # Tizen 6.5+ unsigned widget bundle (relative assets, no PWA)
npm run build:tizen5  # Tizen 5.0/5.5 widget (Chromium 63) — legacy bundle, no PWA
npm run lint      # ESLint
npm run typecheck # TypeScript only
npm run test      # Run tests

cd server
npm run dev       # Start backend dev server (tsx watch)
npm run typecheck # TypeScript check for backend
npm run audit:prod # Production dependency audit
```

Public widget builds intentionally leave the StreamVault backend URL unset so
each installation can configure its own server at runtime. For a private
preconfigured widget, set either a complete URL or a LAN IP explicitly:

```bash
VITE_SERVER_URL=http://192.168.1.20:3002 npm run build:tizen5
```

```bash
VITE_SERVER_IP=192.168.1.20 npm run build:tizen5
```

## Optional API hardening

Set `STREAMVAULT_AUTH_TOKEN` to protect config, sync/crawl, recordings, and recording-rule APIs. Enter the same value in the optional **Backend token** field when connecting to the StreamVault backend. The client stores it locally only after the full connection check succeeds.

Tokens are backend-specific. StreamVault never sends the active backend's token while probing a different origin, and a successful switch replaces or clears the stored token.

The stream proxy validates client-supplied entry URLs against the configured Xtream server host and optional `STREAMVAULT_PROXY_ALLOWED_HOSTS` entries. Redirects may lead to public CDN origins, but private DNS/IP destinations are rejected; private LAN redirects are allowed only back to the same saved Xtream origin. HLS manifests give their rewritten CDN segment URLs expiring URL-bound tickets; an arbitrary public URL cannot be sent directly to `/api/proxy`.

Useful server environment variables:

- `STREAMVAULT_AUTH_TOKEN` - optional bearer/header token for protected APIs
- `STREAMVAULT_PROXY_ALLOWED_HOSTS` - comma-separated extra proxy host allowlist
- `STREAMVAULT_ALLOWED_ORIGINS` - comma-separated explicit CORS origins

## VPN-routed Xtream upstream (optional)

VPN routing is fully opt-in: the normal `docker compose up -d` command and base `docker-compose.yml` continue to use direct host egress. The VPN is enabled only when `docker-compose.vpn.yml` is explicitly included.

StreamVault can run inside a [Gluetun](https://github.com/qdm12/gluetun) network namespace so every Xtream API and media request exits through a VPN while clients keep using the same StreamVault URL (`http://<server>:3002`). This includes API sync, EPG, artwork redirects, live streams, VOD, series episodes, and recordings. Gluetun's firewall is fail-closed, so a dropped tunnel cannot silently leak upstream traffic through the host connection.

WireGuard is recommended for low overhead and high-bitrate/4K playback. The default VPN location is Finland:

```bash
cp .env.vpn.example .env
chmod 600 .env
# Edit .env with credentials from a Gluetun-supported VPN provider.
# Keep VPN_TYPE=wireguard and VPN_SERVER_COUNTRIES=Finland where supported.

docker compose -f docker-compose.yml -f docker-compose.vpn.yml up -d
```

Verify the tunnel and unchanged client endpoint:

```bash
# Gluetun must be healthy and report a Finnish exit location.
docker compose -f docker-compose.yml -f docker-compose.vpn.yml ps
docker exec streamvault-vpn wget -qO- https://ipinfo.io/json

# The PWA/API stays available at the original address.
curl --fail http://127.0.0.1:3002/api/health
```

Use credentials generated specifically for the provider's manual WireGuard/OpenVPN setup; they may differ from its normal app login. `.env` is gitignored. Do not add a direct `ports` mapping back to the `server` service in VPN mode, because the port belongs to Gluetun's network namespace.

To return to direct egress:

```bash
docker compose -f docker-compose.yml -f docker-compose.vpn.yml down
docker compose up -d
```

## Tizen signing

`npm run sign` signs `dist/` with OpenSSL rather than bundling vulnerable JS certificate parsers. Provide certificate paths via `CERT_AUTHOR_P12` and `CERT_DIST_P12`, or place them at `certs/author.p12` and `certs/distributor.p12`. `CERT_AUTHOR_PASSWORD` and `CERT_DIST_PASSWORD` are required.

`npm run sign:tizen5` does the same for the Tizen 5.0/5.5 widget, and `TIZEN_TARGET=5` switches `scripts/package-wgt.sh`, `scripts/deploy-tv.sh` and `scripts/sign-and-deploy.cjs` to that build. `public/config.xml` declares `required_version="6.5"` for the default widget; the tizen5 build lowers its own copy to `5.0` at build time, so each flavour installs only where it runs.

The **Build Tizen WGT** workflow builds both flavours as **unsigned** `.wgt` files. A Samsung TV installs a widget only when it is signed with a Samsung distributor certificate for that TV, and updates it only under the same author certificate as before. Apps2Samsung can handle signing during installation; for manual installation use your own Certificate Manager profile: `tizen package -t wgt -s <your profile> -- StreamVault-tizen5-unsigned.wgt`, or unzip it into `dist/` and run `node scripts/sign-wgt.cjs`. Reuse the same signing identity for updates.

## Install on a Samsung TV with Apps2Samsung

1. **Run the backend first** on a PC/NAS/Raspberry Pi on the TV's network using [Backend required](#backend-required). Confirm `http://<backend-ip>:3002/api/health` is reachable from another LAN device. The `.wgt` contains only the frontend; it does not contain the backend or an IPTV subscription.
2. Download [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases) on a computer or phone on the same network as the TV. Enable Developer Mode on the TV and configure it to allow that device's IP, following [Apps2Samsung's TV setup instructions](https://github.com/Apps2Samsung/Apps2Samsung/wiki/FAQ#-how-to-enable-developer-mode-on-your-tv). Restart the TV if prompted.
3. Download **one** unsigned widget from the [StreamVault releases](https://github.com/christopherklint97/streamvault/releases): `StreamVault-tizen5-unsigned.wgt` for Tizen 5.0/5.5 (including older 2019 TVs such as QE49Q70RATXXC), or `StreamVault-default-unsigned.wgt` for Tizen 6.5+. Check the Tizen version in TV settings or Apps2Samsung if unsure. Do not install the default widget on Tizen 5.
4. Open Apps2Samsung, discover/select the TV (or enter its IP), choose the **custom/local `.wgt`** installation option, and select the downloaded file. Follow its Samsung account/certificate prompts and install. Apps2Samsung signs the widget for that TV; uploading an unsigned `.wgt` to GitHub alone cannot install it. Keep the installer signing identity for future updates.
5. Launch StreamVault on the TV. In **Settings**, enter `http://<backend-ip>:3002` as **StreamVault Server URL** and select **Connect**. Add your provider's Xtream URL and credentials only after the backend connects. A provider URL is not the StreamVault backend URL.

The [Apps2Samsung community catalog entry](https://github.com/Apps2Samsung/tizen-community-packages/blob/main/packages/christopherklint97__streamvault.json) is currently disabled; use the custom/local `.wgt` path rather than expecting StreamVault in its catalog. Installation on a physical TV has not been verified by this repository's automated build.

### Publishing the two widget assets

From GitHub **Actions → Build Tizen WGT → Run workflow**, choose the branch to build and select **release** only when you intend to publish. The run always builds and validates both flavours, then uploads one Actions artifact (`StreamVault-unsigned-wgts`) with the two distinct files above. With **release** checked, it also creates **one GitHub Release** with both `.wgt` files attached. Without it, download the Actions artifact (no release is created). The release tag includes the widget version and run ID/attempt so reruns do not overwrite an earlier release. Both public builds leave `VITE_SERVER_URL` and `VITE_SERVER_IP` empty; configure the backend on each TV after installation. Review and test the assets before promoting a release or requesting a community catalog update; this workflow does not enable or modify the catalog.

## Deployment

Self-hosting: see [Run with Docker](#run-with-docker). The image serves both the
API and the PWA on port 3002.

### Raspberry Pi production (maintainer)

Production runs from a detached worktree whose `.env` pins
`COMPOSE_PROJECT_NAME=streamvault`, `COMPOSE_FILE` and
`STREAMVAULT_IMAGE=streamvault-server:latest`. Deploy the CI-built image; do not
run `docker compose up --build` on the Pi.

```bash
cd ~/services/streamvault-production
scripts/deploy-pi.sh --wait              # origin/main; waits for CI to publish sha-<commit>
scripts/deploy-pi.sh --wait <commit|ref> # a specific green commit on main
scripts/deploy-pi.sh --rollback          # newest streamvault-server:rollback-<stamp>
scripts/deploy-pi.sh --rollback rollback-20261107-201500
```

The script verifies the image's build-provenance attestation against this
repository's CI workflow and commit (fail closed; `--skip-verify` bypasses it),
refuses to restart while a recording is running, finalizing or about to start
(`--force` overrides), keeps the five newest rollback tags, runs
`docker compose up -d --no-build --pull never`, and waits for `/api/health`.
It needs `gh` 2.49 or newer for `gh attestation` (or `GH=/path/to/gh`).

### Tizen TV

```bash
./scripts/deploy-tv.sh
```
