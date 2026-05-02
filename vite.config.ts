import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// When VITE_SERVER_URL is explicitly set (e.g. "" for Docker/PWA), use it.
// Otherwise detect LAN IP for Tizen TV dev builds.
const serverUrl = process.env.VITE_SERVER_URL !== undefined
  ? process.env.VITE_SERVER_URL
  : `http://${process.env.VITE_SERVER_IP || execSync('hostname -I').toString().trim().split(/\s+/)[0]}:3002`;

/**
 * Tailwind v4 wraps everything in `@layer` (cascade layers), which Chromium
 * <99 (incl. Tizen 6.5 / Chromium 85) treats as an unknown at-rule and skips
 * entirely — leaving zero theme variables and zero utility classes applied.
 * Flatten `@layer name { ... }` blocks to plain CSS so the styles still work
 * on Tizen. Nested at-rules (@media, @supports, @keyframes) are preserved.
 */
function flattenCascadeLayers(): Plugin {
  return {
    name: 'flatten-cascade-layers',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const asset = bundle[fileName];
        if (!fileName.endsWith('.css') || asset.type !== 'asset') continue;
        const css = typeof asset.source === 'string'
          ? asset.source
          : new TextDecoder().decode(asset.source as Uint8Array);
        asset.source = flatten(css);
      }
    },
  };
}

function flatten(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('@layer', i)) {
      // Skip whitespace and any layer name(s) up to `{` or `;`
      let j = i + 6;
      while (j < css.length && css[j] !== '{' && css[j] !== ';') j++;
      if (css[j] === ';') {
        // `@layer name;` — declaration without body, drop it
        i = j + 1;
        continue;
      }
      if (css[j] !== '{') break;
      // Find matching closing brace
      let depth = 1;
      let k = j + 1;
      while (k < css.length && depth > 0) {
        const ch = css[k];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
        k++;
      }
      // Recurse so nested @layer blocks are also flattened
      out += flatten(css.slice(j + 1, k));
      i = k + 1;
      continue;
    }
    out += css[i++];
  }
  return out;
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    flattenCascadeLayers(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'StreamVault',
        short_name: 'StreamVault',
        description: 'Stream your media library',
        start_url: '/',
        display: 'standalone',
        background_color: '#0a0a12',
        theme_color: '#0a0a12',
        orientation: 'any',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /\/api\/(?!stream|proxy)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  define: {
    __SERVER_URL__: JSON.stringify(serverUrl),
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  build: {
    target: 'es2017',
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
