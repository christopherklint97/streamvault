import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import postcss from 'postcss'
import postcssPresetEnv from 'postcss-preset-env'

// When VITE_SERVER_URL is explicitly set (e.g. "" for Docker/PWA), use it.
// Otherwise detect LAN IP for Tizen TV dev builds.
const serverUrl = process.env.VITE_SERVER_URL !== undefined
  ? process.env.VITE_SERVER_URL
  : `http://${process.env.VITE_SERVER_IP || execSync('hostname -I').toString().trim().split(/\s+/)[0]}:3002`;

/**
 * Lower modern CSS to syntax old Samsung Tizen browsers understand.
 *
 * Why: Tailwind v4 emits `@layer`, `:is()`/`:where()`, `oklch()` colors, and
 * other features that Chromium <99 silently drops, leaving the TV with no
 * styles. We target Chrome 76 to cover Tizen 6.0 (2021 sets) and up.
 *
 * Runs at `generateBundle` (post-build) on the final CSS asset so it catches
 * everything Tailwind, Vite, and any plugin emit — regardless of where each
 * one sits in the transform pipeline.
 */
function lowerModernCss(): Plugin {
  const processor = postcss([
    postcssPresetEnv({
      // stage 2 = features approaching standard; conservative default.
      stage: 2,
      browsers: 'Chrome >= 76',
      features: {
        // Tailwind's @theme generates plenty of `var(--foo)` references —
        // Chromium 76 supports custom properties natively, no need to inline.
        'custom-properties': false,
        // Explicit opt-ins for things we know break on old Tizen:
        'cascade-layers': true,
        'is-pseudo-class': true,
        'has-pseudo-class': true,
        'oklab-function': true,
        'color-functional-notation': true,
      },
    }),
  ]);

  return {
    name: 'lower-modern-css',
    enforce: 'post',
    async generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const asset = bundle[fileName];
        if (!fileName.endsWith('.css') || asset.type !== 'asset') continue;
        const css = typeof asset.source === 'string'
          ? asset.source
          : new TextDecoder().decode(asset.source as Uint8Array);
        const result = await processor.process(css, { from: undefined });
        asset.source = result.css;
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    lowerModernCss(),
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
    cssTarget: ['chrome76'],
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
