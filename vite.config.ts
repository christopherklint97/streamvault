import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { VitePWA } from 'vite-plugin-pwa'
import postcss from 'postcss'
import postcssPresetEnv from 'postcss-preset-env'
import type { Plugin as PostcssPlugin, Rule as PostcssRule } from 'postcss'
import { CACHEABLE_API_PATTERN } from './src/utils/pwa-cache.ts'

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
 * styles. The default build targets Chrome 76 to cover Tizen 6.0 (2021 sets)
 * and up; the `tizen5` mode targets Chrome 63 (Tizen 5.0/5.5, 2019–2020 sets)
 * and adds two fixups preset-env has no feature for (see below).
 *
 * Runs at `generateBundle` (post-build) on the final CSS asset so it catches
 * everything Tailwind, Vite, and any plugin emit — regardless of where each
 * one sits in the transform pipeline.
 */
function lowerModernCss(opts: { browsers: string; legacy: boolean }): Plugin {
  const processor = postcss([
    postcssPresetEnv({
      // stage 2 = features approaching standard; conservative default.
      stage: 2,
      browsers: opts.browsers,
      features: {
        // Tailwind's @theme generates plenty of `var(--foo)` references —
        // Chromium 63+ supports custom properties natively, no need to inline.
        'custom-properties': false,
        // Explicit opt-ins for things we know break on old Tizen:
        'cascade-layers': true,
        'is-pseudo-class': true,
        'has-pseudo-class': true,
        'oklab-function': true,
        'color-functional-notation': true,
      },
    }),
    ...(opts.legacy ? [tizenFlexGapFallback(), tizenInsetLonghand()] : []),
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

/**
 * Chromium 63 predates `gap` in FLEXBOX (Chrome 84) — it is silently ignored
 * and every flex layout collapses together. Grid `gap` shorthands only work
 * from Chrome 66; Chrome 47–65 need the `grid-*` names (still honored by
 * modern browsers). This plugin REPLACES flex gap with child-margin rules and
 * renames grid gap, which render identically from Chrome 47 to current — no
 * @supports gymnastics, no double spacing.
 *
 *   row (default):        .sel > * + * { margin-left: <gap> }
 *   flex-direction:column .sel > * + * { margin-top: <gap> }
 *   flex-wrap:wrap        .sel > *     { margin: 0 <gap> <gap> 0 }
 *
 * NB: only fires on rules that declare display + gap together. Tailwind's
 * atomic utilities split these across rules, so author your own gapped flex
 * containers as combined rules (or use grid) for correct TV spacing.
 */
function tizenFlexGapFallback(): PostcssPlugin {
  return {
    postcssPlugin: 'tizen-flex-gap-fallback',
    OnceExit(root, { Rule, Declaration }) {
      root.walkRules((rule) => {
        if (!rule.selector || rule.selector.includes('>')) return
        let display: string | undefined
        let gap: string | undefined
        let rowGap: string | undefined
        let colGap: string | undefined
        let column = false
        let wrap = false
        rule.walkDecls((d) => {
          if (d.prop === 'display') display = d.value
          else if (d.prop === 'gap') gap = d.value
          else if (d.prop === 'row-gap') rowGap = d.value
          else if (d.prop === 'column-gap') colGap = d.value
          else if (d.prop === 'flex-direction' && d.value.includes('column')) column = true
          else if (d.prop === 'flex-wrap' && d.value.includes('wrap')) wrap = true
        })
        if (!gap && !rowGap && !colGap) return
        if (display && /grid/.test(display)) {
          // GRID: rename to the grid-* longhands Chrome 47–65 honor.
          rule.walkDecls((d) => {
            if (d.prop === 'gap') d.prop = 'grid-gap'
            else if (d.prop === 'row-gap') d.prop = 'grid-row-gap'
            else if (d.prop === 'column-gap') d.prop = 'grid-column-gap'
          })
          return
        }
        if (!display || !/flex/.test(display)) return
        const parts = (gap || '').trim().split(/\s+/)
        const rg = rowGap || parts[0]
        const cg = colGap || parts[1] || parts[0]
        rule.walkDecls((d) => {
          if (d.prop === 'gap' || d.prop === 'row-gap' || d.prop === 'column-gap') d.remove()
        })
        const childRule: PostcssRule = new Rule({
          selector: rule.selectors.map((s) => (wrap ? `${s} > *` : `${s} > * + *`)).join(',\n'),
        })
        if (wrap) {
          childRule.append(new Declaration({ prop: 'margin', value: `0 ${cg} ${rg} 0` }))
        } else {
          childRule.append(
            new Declaration({ prop: column ? 'margin-top' : 'margin-left', value: column ? rg : cg })
          )
        }
        rule.after(childRule)
      })
    },
  }
}

/**
 * `inset` shorthand is Chrome 87+ — older WebViews drop the declaration and
 * fixed/absolute overlays land in the wrong place. Expand to longhands.
 */
function tizenInsetLonghand(): PostcssPlugin {
  return {
    postcssPlugin: 'tizen-inset-longhand',
    Declaration: {
      inset(decl, { Declaration }) {
        const v = decl.value.trim().split(/\s+/)
        const [top, right = v[0], bottom = v[0], left = right] = v
        decl.replaceWith(
          new Declaration({ prop: 'top', value: top }),
          new Declaration({ prop: 'right', value: right }),
          new Declaration({ prop: 'bottom', value: bottom }),
          new Declaration({ prop: 'left', value: left })
        )
      },
    },
  }
}

/**
 * Force the widget to run ONLY the fully-transpiled SystemJS bundle that
 * @vitejs/plugin-legacy emits. Chrome 63 supports `<script type=module>`, so
 * with dual output it would otherwise pick the MODERN bundle and choke on
 * `import.meta` / `?.` syntax. We:
 *   1. drop every module/modulepreload tag from index.html,
 *   2. un-gate the legacy scripts (remove `nomodule`),
 *   3. strip `crossorigin` — the widget loads from a local scheme with no CORS
 *      headers, so the WebView REFUSES any crossorigin-tagged script/CSS,
 *   4. delete the now-unreferenced modern JS chunks from the bundle.
 * Verified against headless Chromium 63 (same engine as Tizen 5.0).
 * (renderModernChunks:false is avoided — it silently drops the CSS asset:
 * vitejs/vite#10782, #14324.)
 */
function tizenLegacyOnly(): Plugin {
  return {
    name: 'tizen-legacy-only',
    enforce: 'post',
    transformIndexHtml(html: string) {
      return html
        .replace(/<script type="module"[^>]*src="[^"]*"[^>]*><\/script>\s*/g, '')
        .replace(/<script type="module">[\s\S]*?<\/script>\s*/g, '')
        .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
        .replace(/<script nomodule/g, '<script')
        .replace(/ crossorigin(?:="[^"]*")?/g, '')
    },
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const chunk = bundle[fileName]
        if (
          fileName.endsWith('.js') &&
          chunk.type === 'chunk' &&
          !fileName.includes('-legacy')
        ) {
          delete bundle[fileName]
        }
      }
    },
  }
}

// Two build flavours from one config:
//
//   vite build                  default — PWA + Tizen 6.5+ widget (ES2017,
//                               CSS lowered to Chrome 76). Unchanged.
//   vite build --mode tizen5    Tizen 5.0/5.5 widget (Chromium 63): a fully
//                               transpiled SystemJS bundle with relative asset
//                               paths and CSS lowered to Chrome 63. No PWA —
//                               a widget has no use for a service worker.
//
// `--mode` rather than an env var so it works the same from npm scripts on
// every OS, and so NODE_ENV stays `production` (Vite only ties that to the
// `development` mode).
export default defineConfig(({ mode }) => {
  const tizen5 = mode === 'tizen5';

  return {
    plugins: [
      tailwindcss(),
      react(),
      lowerModernCss({ browsers: tizen5 ? 'Chrome >= 63' : 'Chrome >= 76', legacy: tizen5 }),
      ...(tizen5
        ? [
            // Tizen TVs run old Chromium WebViews (Tizen 5.x = Chrome 63,
            // 4.0 = 56, 3.0 = 47). Transpile + polyfill down to Chrome 47 so
            // the same widget has a chance on the older sets too.
            legacy({ targets: ['chrome >= 47'] }),
            tizenLegacyOnly(),
          ]
        : [
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
                    urlPattern: CACHEABLE_API_PATTERN,
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
          ]),
    ],
    // A Tizen 5 widget loads from a local scheme, so its assets must be
    // referenced relatively (`./assets/...`), not from the site root.
    base: tizen5 ? './' : '/',
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
      target: tizen5 ? ['chrome63'] : 'es2017',
      cssTarget: tizen5 ? ['chrome63'] : ['chrome76'],
      // Nothing to preload once the module scripts are gone.
      ...(tizen5 ? { modulePreload: false } : {}),
      outDir: 'dist',
    },
    server: {
      proxy: {
        '/api': 'http://localhost:3001',
      },
    },
  };
})
