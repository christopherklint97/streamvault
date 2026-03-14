# CLAUDE.md

## Build & Test Commands

- `npm run build` - TypeScript check + Vite build
- `npm run lint` - ESLint
- `npm run typecheck` - TypeScript type checking
- `npm run test` - Run tests with Vitest
- `npm run dev` - Start dev server
- `cd server && npm run dev` - Start backend server

## Code Style & Conventions

- TypeScript strict mode with `verbatimModuleSyntax` - use `import type` for type-only imports
- `noUnusedLocals` and `noUnusedParameters` enabled - no unused variables
- Build target: ES2017 (Tizen 6.5 / Chromium 85 compatibility)
- React 19 rules: no refs during render, no setState in effects, no impure functions in render
- **Never use eslint-disable comments** - fix the actual issue instead
- **Use `useMemo` for derived state** - never derive state by calling `setState` inside a `useEffect`; use `useMemo` or compute inline instead
- Zustand v5 stores in `src/stores/`

## Architecture

- `src/types.ts` - Core types (Channel, Program, MovieInfo, FavoriteList, View, PlayerState)
- `src/services/` - Data layer (epg-service, channel-service, avplay)
- `src/stores/` - State management (channelStore, favoritesStore, playerStore, appStore)
- `src/hooks/` - Custom hooks (useFocusNavigation, useRemoteKeys, usePlayer, useNetworkStatus)
- `src/components/` - UI components (Player, ChannelList, ChannelCard, MovieDetail, SeriesDetail, Sidebar, HorizontalRow)
- `src/pages/` - Page-level components (Home, Settings)
- `server/src/` - Express API, SQLite DB, Xtream client (xtream.ts), sync engine
- `scripts/` - Tizen signing, packaging, and deployment scripts

## Views / Navigation

- `home` - Homepage with Continue Watching, Favorites, Custom Lists, Browse
- `channels` - Live TV browse (list view on mobile)
- `movies` - Movies browse (grid view)
- `movieDetail` - Movie info page (poster, plot, rating, play button)
- `series` - Series browse (grid view)
- `seriesDetail` - Series info with season/episode browser
- `player` - Fullscreen video player
- `settings` - Server URL + source configuration

## API Endpoints

- `GET /api/browse?type=X&group=Y&limit=N&after=cursor` - Paginated content browsing
- `GET /api/categories` - Content categories
- `GET /api/search?q=X&type=Y` - Server-side search
- `GET /api/vod/:vodId` - Movie/VOD detail info (Xtream get_vod_info)
- `GET /api/series/:seriesId` - Series detail info
- `GET /api/epg/:streamId` - EPG for specific stream
- `GET /api/stream/:channelId` - Stream proxy
- `GET/PUT /api/config` - App configuration
- `POST /api/sync` - Trigger sync

## Environment

- Platform: Raspberry Pi (aarch64), Debian 13
- Node v24+ via nvm - run `source ~/.zshrc` before node/npm commands in shell
- Package manager: npm
- Docker deployment: `docker compose up -d --build` from project root
