# StreamVault

IPTV streaming app for Samsung Tizen smart TVs and mobile PWA. Built with React, TypeScript, and Vite, with a Node.js backend server.

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

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7, Zustand 5
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
npm run build     # TypeScript check + Vite build
npm run lint      # ESLint
npm run typecheck # TypeScript only
npm run test      # Run tests

cd server
npm run dev       # Start backend dev server (tsx watch)
```

## Deployment

```bash
# Docker (serves both API + PWA on port 3002)
docker compose up -d --build

# Tizen TV
./scripts/deploy-tv.sh
```
