# StreamVault

IPTV streaming app for Samsung Tizen smart TVs. Built with React, TypeScript, and Vite, targeting Tizen 6.5 (Chromium 85).

## Features

- M3U playlist parsing and channel management
- EPG (Electronic Program Guide) with virtual scrolling grid
- AVPlay integration with HTML5 video fallback
- D-pad/remote control navigation
- Favorites management with persistent storage
- Network status monitoring

## Tech Stack

- React 19, TypeScript 5.9, Vite 7
- Zustand 5 for state management
- Vitest for testing
- Tizen TV CLI for packaging and deployment

## Project Structure

```
src/
  services/     # M3U parser, EPG service, channel service, AVPlay wrapper
  stores/       # Zustand stores (channel, favorites, player, app)
  hooks/        # Focus navigation, remote keys, player, network status
  components/   # Sidebar, ChannelCard, ChannelList, EPGGrid, Player, etc.
  pages/        # Home, Settings
  types.ts      # Core type definitions
  tizen.d.ts    # Tizen API type declarations
scripts/        # Signing, packaging, and deployment scripts
```

## Development

```bash
npm install
npm run dev       # Start dev server
npm run build     # TypeScript check + Vite build
npm run lint      # ESLint
npm run typecheck # TypeScript only
npm run test      # Run tests
```

## Tizen Deployment

```bash
npm run sign      # Build and sign WGT package
npm run deploy    # Sign and deploy to connected TV
```

## CI/CD

GitHub Actions workflow at `.github/workflows/build-deploy.yml` handles automated builds and WGT packaging.
