import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { VitePWA } from 'vite-plugin-pwa'
import postcss from 'postcss'
import postcssPresetEnv from 'postcss-preset-env'
import type { Plugin as PostcssPlugin, Declaration as PostcssDeclaration } from 'postcss'
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
 * and adds the fixups preset-env has no feature for (the tizen* plugins below).
 *
 * Runs at `generateBundle` (post-build) on the final CSS asset so it catches
 * everything Tailwind, Vite, and any plugin emit — regardless of where each
 * one sits in the transform pipeline.
 */
function lowerModernCss(opts: { browsers: string; legacy: boolean }): Plugin {
  const processor = postcss([
    // Before preset-env, so its `:is()` lowering also covers `:where()`.
    ...(opts.legacy ? [tizenWhereToIs()] : []),
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
    ...(opts.legacy
      ? [
          tizenPropertyInitialValues(),
          tizenGapAlias(),
          tizenTransformLonghand(),
          tizenInsetLonghand(),
          tizenViewportUnits(),
          tizenGradientInterpolation(),
        ]
      : []),
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
 * `:where()` is Chrome 88+. preset-env lowers `:is()` but has no feature for
 * `:where()`, and Chromium 63 drops any rule whose selector it cannot parse —
 * Tailwind's `group-*` variants and a good part of its preflight go with it.
 * The only difference between the two is specificity, which matters less
 * than the rule existing at all, so swap the name and let the `:is()`
 * lowering take it from there.
 */
function tizenWhereToIs(): PostcssPlugin {
  return {
    postcssPlugin: 'tizen-where-to-is',
    Rule(rule) {
      if (rule.selector.includes(':where(')) rule.selector = rule.selector.replace(/:where\(/g, ':is(')
    },
  }
}

/**
 * `@property` is Chrome 85+. Tailwind v4 registers every `--tw-*` variable
 * with it and leans on the registered initial value: `.border` is
 * `border-style: var(--tw-border-style)`, a shadow or gradient is a chain of
 * `var()`s, a transform utility reads the axes it does not set. Its own
 * fallback for engines without `@property` is an `@supports` block keyed on
 * `-webkit-hyphens`, which Chromium 63 on Tizen does not match either
 * (checked in headless Chrome 63: the block's variables come back empty). So
 * on that engine every one of those `var()`s is undefined, the declaration is
 * invalid at computed-value time, and borders, shadows, gradients and
 * transforms vanish. Replay the registered initial values as one universal
 * rule at the top of the sheet — the same shape as Tailwind's fallback, made
 * unconditional — and drop the `@property` rules the engine would ignore.
 */
function tizenPropertyInitialValues(): PostcssPlugin {
  return {
    postcssPlugin: 'tizen-property-initial-values',
    OnceExit(root, { Rule, Declaration }) {
      const initial: PostcssDeclaration[] = []
      root.walkAtRules('property', (at) => {
        const name = at.params.trim()
        at.walkDecls('initial-value', (d) => {
          initial.push(new Declaration({ prop: name, value: d.value }))
        })
        at.remove()
      })
      if (initial.length === 0) return
      const defaults = new Rule({ selector: '*, :before, :after, ::backdrop' })
      defaults.append(...initial)
      // After any leading @charset/@import, which must stay first.
      const anchor = root.nodes.find(
        (n) => !(n.type === 'atrule' && (n.name === 'charset' || n.name === 'import'))
      )
      if (anchor) anchor.before(defaults)
      else root.append(defaults)
    },
  }
}

/**
 * Chromium 63 predates `gap` on flex containers (Chrome 84) and knows grid gap
 * only under its `grid-*` names (Chrome 57–65; the unprefixed shorthands are
 * Chrome 66). Rename every gap declaration to that alias, which current
 * engines still honor on grid and flex alike. On the old engine that gives
 * grid containers their spacing natively — and, although it ignores the
 * property on a flex container, it still COMPUTES it there, which is what
 * scripts/tizen5-flex-gap.js reads back to turn into margins on the children.
 * That runtime is what makes Tailwind's atomic utilities work: a fallback
 * chosen per element from computed display and direction, not per rule, so
 * the stylesheet never needs to know that `flex`, `flex-col`, `lg:flex-row`
 * and `gap-3` meet on the same element.
 */
function tizenGapAlias(): PostcssPlugin {
  return {
    postcssPlugin: 'tizen-gap-alias',
    Declaration(decl) {
      if (decl.prop === 'gap') decl.prop = 'grid-gap'
      else if (decl.prop === 'row-gap') decl.prop = 'grid-row-gap'
      else if (decl.prop === 'column-gap') decl.prop = 'grid-column-gap'
    },
  }
}

/**
 * The individual transform properties `translate`, `rotate` and `scale` are
 * Chrome 104+. Chromium 63 drops them, so Tailwind's translate-* and scale-*
 * utilities do nothing there: a centred overlay sits in the wrong corner and
 * a focused tile never grows. Fold each such rule into one `transform` built
 * from the same `--tw-*` variables Tailwind sets, in the order the individual
 * properties apply (translate, rotate, scale), so utilities from separate
 * rules still compose on one element. A literal value (`scale: 1.02`) is
 * moved into the variables first. Percentages become plain numbers, because
 * `scale(105%)` is Transforms Level 2 syntax the old engine rejects as well.
 */
function tizenTransformLonghand(): PostcssPlugin {
  const composed =
    'translate(var(--tw-translate-x, 0), var(--tw-translate-y, 0)) ' +
    'rotate(var(--tw-rotate, 0deg)) ' +
    'scale(var(--tw-scale-x, 1), var(--tw-scale-y, 1))'
  const percentToNumber = (v: string) =>
    v.replace(/(-?\d*\.?\d+)%/g, (_, n: string) => String(parseFloat(n) / 100))
  const parts = (v: string) => v.trim().split(/\s+/)
  return {
    postcssPlugin: 'tizen-transform-longhand',
    OnceExit(root, { Declaration }) {
      root.walkRules((rule) => {
        const individual = rule.nodes.filter(
          (n): n is PostcssDeclaration =>
            n.type === 'decl' && (n.prop === 'translate' || n.prop === 'scale' || n.prop === 'rotate')
        )
        if (individual.length === 0) return
        const has = (prop: string) => rule.some((n) => n.type === 'decl' && n.prop === prop)
        const define = (prop: string, value: string) => {
          if (!has(prop)) rule.append(new Declaration({ prop, value }))
        }
        rule.walkDecls(/^--tw-scale-/, (d) => {
          d.value = percentToNumber(d.value)
        })
        for (const d of individual) {
          const literal = !d.value.includes('var(')
          if (d.prop === 'translate') {
            const [x, y = '0'] = d.value === 'none' ? ['0', '0'] : parts(d.value)
            if (literal) {
              define('--tw-translate-x', x)
              define('--tw-translate-y', y)
            }
          } else if (d.prop === 'scale') {
            const [x, y = x] = d.value === 'none' ? ['1', '1'] : parts(percentToNumber(d.value))
            if (literal) {
              define('--tw-scale-x', x)
              define('--tw-scale-y', y)
            }
          } else if (literal) {
            define('--tw-rotate', d.value === 'none' ? '0deg' : d.value)
          }
          d.remove()
        }
        rule.append(new Declaration({ prop: 'transform', value: composed }))
      })
    },
  }
}

/**
 * Chromium 63 has neither `dvh` (Chrome 108) nor `env()` (Chrome 69), and a
 * value using either is dropped whole — `min-h-[60dvh]` becomes no
 * min-height, and every safe-area padding disappears. A TV has no dynamic
 * toolbar and no notch, so `dvh` is `vh` there and `env(safe-area-inset-*)`
 * is whatever fallback the author gave it (or nothing).
 */
function tizenViewportUnits(): PostcssPlugin {
  const safeArea = /env\(\s*safe-area-inset-[a-z]+\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g
  return {
    postcssPlugin: 'tizen-viewport-units',
    Declaration(decl) {
      const before = decl.value
      if (!/dvh|env\(/.test(before)) return
      const after = before
        .replace(/(\d)dvh\b/g, '$1vh')
        .replace(safeArea, (_, fallback?: string) => (fallback ?? '0px').trim())
      if (after !== before) decl.value = after
    },
  }
}

/**
 * Tailwind v4 writes its gradient direction as `to right in oklab`. The colour
 * interpolation method is Chrome 111+ syntax, so on Chromium 63 every
 * `linear-gradient()` built from it is invalid and each `bg-gradient-to-*`
 * renders nothing. Drop the method (and any hue-direction after it); the
 * gradient interpolates in sRGB, as it did before Tailwind 4.
 */
function tizenGradientInterpolation(): PostcssPlugin {
  const method = /\s+in\s+[a-z][a-z0-9-]*(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\b/g
  return {
    postcssPlugin: 'tizen-gradient-interpolation',
    Declaration(decl) {
      if (decl.prop !== '--tw-gradient-position' && !/gradient\(/.test(decl.value)) return
      const after = decl.value.replace(method, '')
      if (after !== decl.value) decl.value = after
    },
  }
}

/**
 * public/config.xml declares `required_version="6.5"`, which is what the
 * default widget — module scripts, PWA plumbing — needs. The tizen5 flavour
 * is the one built to run on 5.0, so only its copy of the manifest says so:
 * rewritten in the output after Vite has copied public/ there, never in the
 * source, so the two flavours cannot share a version floor by accident.
 */
function tizenWidgetVersionFloor(version: string): Plugin {
  let manifest = ''
  return {
    name: 'tizen-widget-version-floor',
    configResolved(config) {
      manifest = resolve(config.root, config.build.outDir, 'config.xml')
    },
    closeBundle() {
      const xml = readFileSync(manifest, 'utf8')
      const next = xml.replace(/(<tizen:application\b[^>]*\brequired_version=")[^"]*(")/, `$1${version}$2`)
      if (next === xml) throw new Error(`${manifest}: no <tizen:application required_version> to set to ${version}`)
      writeFileSync(manifest, next)
    },
  }
}

/**
 * Inline scripts/tizen5-flex-gap.js into the widget's index.html, in <head>,
 * so it is already observing when the bundle renders its first element. See
 * tizenGapAlias() for the CSS half it depends on.
 */
function tizenFlexGapRuntime(): Plugin {
  // The file's header comment stays with the file; the page gets a pointer.
  const source = readFileSync(fileURLToPath(new URL('./scripts/tizen5-flex-gap.js', import.meta.url)), 'utf8')
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '/* scripts/tizen5-flex-gap.js */\n')
  return {
    name: 'tizen-flex-gap-runtime',
    enforce: 'post',
    transformIndexHtml() {
      return [{ tag: 'script', children: source, injectTo: 'head' }]
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
            legacy({
              targets: ['chrome >= 47'],
              // core-js covers the language; this covers a web API the app
              // leans on for channel loads and subtitle streams that Chromium
              // 63 lacks (AbortController is Chrome 66, and fetch() only
              // honors `signal` from there too — the patch-fetch build of
              // the polyfill wires both).
              additionalLegacyPolyfills: ['abortcontroller-polyfill/dist/polyfill-patch-fetch'],
            }),
            tizenLegacyOnly(),
            tizenFlexGapRuntime(),
            tizenWidgetVersionFloor('5.0'),
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
