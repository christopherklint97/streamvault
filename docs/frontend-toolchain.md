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
`GOMAXPROCS=1` can additionally constrain it when needed. One sequential forced-build
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

## Latest-stable upgrade and verification (2026-10-09)

All 31 root dependency/devDependency declarations are exact stable snapshots.
Each declaration, including both npm compiler aliases, was rechecked against
its registry `latest` endpoint and lockfile version/integrity on 2026-10-09.
The remaining `serialize-javascript` override was independently checked too.
The version changes from the previous snapshot are:

| Package | Previous | Current |
| --- | --- | --- |
| `preact` | 10.29.8 | 11.0.1 |
| `vite-plugin-pwa` | 1.3.0 | 2.0.0 |
| `@types/node` | 26.6.4 | 26.6.5 |
| `serialize-javascript` override | 7.0.5 | 7.1.2 |

The other packages were already latest stable; former caret ranges are now
exact pins. Media dependencies, legacy plugin, AbortController polyfill, and
all old-TV CSS/runtime transforms remain unchanged.

### Verified compatibility changes

- Preact 11.0.1 raises its **optional** `preact-render-to-string` peer from `>=5`
  to `>=6.7.0`. This client-only app does not invoke server rendering, so no SSR
  package was added. Retain the existing exact React/ReactDOM/JSX aliases and
  real Zustand integration coverage.
- The initial upgraded suite had **491 passing tests and one failing test**:
  the manifest contract explicitly expected Preact 10.29.8. Updating that
  exact contract to 11.0.1 produced **492 passing tests across 60 files**. No
  runtime, gesture, playback, act-helper, or assertion weakening was needed;
  no other Preact compatibility regression was observed in the existing suite.
  This does not establish compatibility for every Preact API or physical TV.
- PWA 2.0.0 raises its Node engine from `>=16.0.0` to `>=20.19.0` and expands
  the optional assets-generator peer to include version 2. Existing Vite 8.3.4
  and Workbox 7.4.1 satisfy its published peers. The PWA/Vite override was
  removed; a clean **strict-peer** install and `npm ls --all` prove it is not
  needed. Node 26.7.0/npm 11.19.0 were used for this verification.
- The compatibility compiler aliases remain exact and retain TS7 CLI 7.0.2
  plus TS6 JavaScript API 6.0.3; both compiler checks and ESLint pass.

### Commands and artifacts

```sh
npm install --package-lock-only --strict-peer-deps --ignore-scripts
npm ci --strict-peer-deps --include=dev
npm ls --all
npm run typecheck -- --force
npm run typecheck:compat
npm run lint
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
npm run build:wgt
npm run build:tizen5
npm audit --json
```

All commands pass; audit reports zero vulnerabilities. Heavy operations ran
sequentially on one CPU at nice 15, with a 512 MiB Node heap,
`GOMAXPROCS=1`, `GOMEMLIMIT=512MiB`, one Vitest worker, and no file parallelism.
The lock update includes npm's bundled optional WASI dependency metadata;
this is not a direct dependency upgrade.

Web builds generate the service worker (13 precache entries), manifest, and
four Brotli/gzip-compressed JS/CSS assets. Widget artifacts have relative local
asset paths, no `crossorigin` attributes, and no service worker/manifest output.
Tizen retains the 6.5 floor; Tizen5 retains its 5.0 floor, flex-gap runtime,
CSS output, and exclusively legacy JavaScript chunks with ungated scripts.
An initial scratch artifact assertion matched the word `nomodule` inside the
legacy plugin's inline Safari feature probe; checking actual script attributes
instead passed. No build/source change was warranted for that audit false
positive.

Full structured commands, logs, fresh registry metadata, artifact file sizes
and SHA-256 hashes are recorded in:
`/home/christopherklint/.hermes/reports/streamvault-latest-frontend-upgrade-2026-10-09.json`.
Separate web/Tizen/Tizen5 outputs are archived beneath
`/home/christopherklint/.hermes/cache/scratch/streamvault-frontend-builds/`;
the worktree's `dist/` contains the verified web build for separate canary work.

Transitive glob 11.1.0 deprecation, the npm core-js postinstall allowScripts
notice, large-media-chunk warnings, and the legacy-plugin target warning remain
visible and were not suppressed. No signing, deployment, Docker build,
production change, real-stream request, or physical-device validation is part
of this frontend verification. There are no unresolved frontend install,
compiler, lint, test, or build blockers. Production comparison/canary and
physical iPhone/TV acceptance remain separate gates.
