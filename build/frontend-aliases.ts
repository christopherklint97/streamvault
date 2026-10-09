import type { AliasOptions } from 'vite';

// Exact matches avoid rewriting react/jsx-runtime to preact/compat/jsx-runtime
// or accidentally matching unrelated packages such as react-dom-extra.
// Both Vite and Vitest must use the same renderer and automatic JSX runtime.
export const frontendAliases: AliasOptions = [
  { find: /^react$/, replacement: 'preact/compat' },
  { find: /^react-dom$/, replacement: 'preact/compat' },
  { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
  { find: /^react-dom\/server$/, replacement: 'preact/compat/server' },
  { find: /^react-dom\/test-utils$/, replacement: 'preact/test-utils' },
  { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
  { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
];
