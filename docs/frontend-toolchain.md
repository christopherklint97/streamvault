# Frontend toolchain

## Compilers: TypeScript 7 CLI, TypeScript 6 API

The standard `tsc` used by `npm run typecheck` and all three build scripts is
stable TypeScript **7.0.2**, including its native Linux ARM64 compiler. The root
package follows Microsoft's [official side-by-side recommendation](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/):

```json
{
  "@typescript/native": "npm:typescript@7.0.2",
  "typescript": "npm:@typescript/typescript6@6.0.2"
}
```

The compatibility package's published version is **6.0.2**, while its compiler
and JavaScript API report **6.0.3**. It exports only the `tsc6` executable, so it
does not compete with TypeScript 7 for `node_modules/.bin/tsc`.

`typescript-eslint` 8.71.1 requires TypeScript `>=4.8.4 <6.1.0` and a JavaScript
compiler API. TypeScript 7.0 does not provide that API. Its parser therefore
resolves `typescript` to the compatibility package, while builds use the native
compiler. Do not replace the compatibility alias with TypeScript 7, use
`native-preview`, or bypass peer validation with `--force`/`--legacy-peer-deps`.

```sh
npm ci
npm exec -- tsc --version        # Version 7.0.2
npm exec -- tsc6 --version       # Version 6.0.3
npm ls --all                    # no invalid peers
npm run typecheck -- --force    # force a full TypeScript 7 comparison
npm run typecheck:compat        # tsc6 -b --force
npm run lint
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build                  # web PWA, then postbuild asset precompression
npm run build:wgt              # Tizen 6.5+; no precompression/PWA
npm run build:tizen5           # legacy-only widget; no precompression/PWA
```

Keep the React JSX/type declarations in `tsconfig.app.json`: this is a
compatibility-renderer migration, not a rewrite to Preact's JSX event/ref types.
`tsconfig.node.json` checks both Vite and Vitest configs and the shared aliases.

For resource-limited hosts, run heavy commands sequentially with
`NODE_OPTIONS=--max-old-space-size=512 nice -n 15 ...`. Native TypeScript's Go
runtime is not governed by Node's heap limit; `GOMEMLIMIT=512MiB` and
`GOMAXPROCS=2` can additionally constrain it when needed. One sequential forced-build
sample on the development Pi took 4.43 seconds with TS7 versus 12.49 seconds
with TS6 (npm command wall time with GOMAXPROCS=1, not a general benchmark).

## One renderer in builds and tests

`build/frontend-aliases.ts` supplies exact-match aliases to **both** Vite and
Vitest: React/ReactDOM entry points use Preact compat, `react-dom/client` uses
`preact/compat/client`, and both automatic JSX runtimes use Preact's JSX runtime.
Specific subpaths do not accidentally become `preact/compat/jsx-runtime`, and
unrelated package names are not rewritten. Tests cover parity in web, Tizen,
and Tizen5 modes as well as module identity, hooks, and real Zustand updates.

Vitest must inline **Zustand**. Otherwise its externalized React import bypasses
Vite's aliases and calls real React hooks inside a Preact tree, causing invalid
hook calls. This is a test pipeline issue, not a reason to mock the store or
change playback behavior.

Integration tests use `src/test/act.ts`, backed by `preact/test-utils`. Preact's
raw async `act` flushes rendering/effects but does not settle detached
`Response.json()`/authorization chains as React's async `act` did. The helper
yields real event-loop turns around that work without advancing fake playback
deadlines. Synchronous gesture callbacks still run and flush synchronously.
Separate input/checkbox changes and subsequent save clicks into separate acts
so Preact commits the draft before the next user action reads it. Existing
integration assertions remain intact.

React and ReactDOM remain development dependencies for peer/type support.
Zustand's optional React peer means npm can still retain **React** in an
`--omit=dev` dependency tree; moving its direct declaration is not a promise
that npm omits it entirely. The production build graph was separately checked:
**5 Preact modules and 0 React/ReactDOM modules** in emitted chunks.

## Upgrade scope and verification

Updated Vite 8.3.4, plugin-react 6.1.2, ESLint 10.12.0, happy-dom 20.14.6,
PostCSS 8.5.29, postcss-preset-env 11.6.1, and typescript-eslint 8.71.1.
Vitest stays at 5.0.3. Preact stays at 10.29.8 and vite-plugin-pwa at 1.3.0;
their new major versions are intentionally not adopted. Media dependencies,
legacy plugin, AbortController polyfill, and all old-TV CSS/runtime transforms
are retained. Existing PWA/Vite and serialize-javascript overrides are retained.

The old lock's optional Babel peer resolution failed during an incremental
plugin-react update. Resolving a fresh lock succeeded normally, and a subsequent
clean `npm ci` succeeded with no invalid peers or peer-bypass flags. Root
`npm audit` reports zero vulnerabilities. npm still warns about transitive
`glob@11.1.0` deprecation and an unapproved optional core-js postinstall notice;
neither prevented installation, tests, or any build.

Web, Tizen, and Tizen5 builds succeeded. Web precompression preserves originals
and the service worker. Widget builds do not emit service workers or compressed
sidecars. Tizen5 output retains its version 5.0 floor, legacy-only scripts,
AbortController, flex-gap runtime, and CSS without `@layer`, `@property`, or
`:where()`. These artifact checks are not an on-device TV/browser smoke test.
Existing large-media-chunk and legacy-plugin target warnings remain visible;
they were not suppressed. No signing, deployment, or production actions are
part of this verification.
