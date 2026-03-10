import { defineConfig } from 'vite'
import { execSync } from 'child_process'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// When VITE_SERVER_URL is explicitly set (e.g. "" for Docker/PWA), use it.
// Otherwise detect LAN IP for Tizen TV dev builds.
const serverUrl = process.env.VITE_SERVER_URL !== undefined
  ? process.env.VITE_SERVER_URL
  : `http://${process.env.VITE_SERVER_IP || execSync('hostname -I').toString().trim().split(/\s+/)[0]}:3002`;

export default defineConfig({
  plugins: [
    react(),
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
            urlPattern: /\/api\//,
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
