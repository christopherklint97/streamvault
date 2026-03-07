# CLAUDE.md

## Build & Test Commands

- `npm run build` - TypeScript check + Vite build
- `npm run lint` - ESLint
- `npm run typecheck` - TypeScript type checking
- `npm run test` - Run tests with Vitest
- `npm run dev` - Start dev server

## Code Style & Conventions

- TypeScript strict mode with `verbatimModuleSyntax` - use `import type` for type-only imports
- `noUnusedLocals` and `noUnusedParameters` enabled - no unused variables
- Build target: ES2017 (Tizen 6.5 / Chromium 85 compatibility)
- React 19 rules: no refs during render, no setState in effects
- Zustand v5 stores in `src/stores/`

## Architecture

- `src/types.ts` - Core types (Channel, Program, View, PlayerState)
- `src/services/` - Data layer (m3u-parser, epg-service, channel-service, avplay)
- `src/stores/` - State management (channelStore, favoritesStore, playerStore, appStore)
- `src/hooks/` - Custom hooks (useFocusNavigation, useRemoteKeys, usePlayer, useNetworkStatus)
- `src/components/` - UI components
- `src/pages/` - Page-level components (Home, Settings)
- `scripts/` - Tizen signing, packaging, and deployment scripts

## Environment

- Platform: Raspberry Pi (aarch64), Debian 13
- Node v24+ via nvm - run `source ~/.zshrc` before node/npm commands in shell
- Package manager: npm
