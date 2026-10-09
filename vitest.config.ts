import { configDefaults, defineConfig } from 'vitest/config';
import { frontendAliases } from './build/frontend-aliases.ts';

export default defineConfig({
  resolve: { alias: frontendAliases },
  test: {
    // Externalized dependencies bypass Vite aliases. Transform Zustand so its
    // React hooks import uses Preact too, just as in the production bundle.
    server: { deps: { inline: ['zustand'] } },
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, '.worktrees/**'],
  },
});
