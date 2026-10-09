# Dependency and production runtime maintenance

## Runtime contract

The server is emitted with TypeScript 7 into `server/dist`, using NodeNext resolution. Production runs `node dist/index.js`, not a TypeScript loader. `npm run dev` retains tsx and source-mode workers; emitted worker and backup entrypoints select `.js` with no loader. The Python packet worker and stitcher are copied beside their emitted callers.

From `server/`:

```bash
npm ci --ignore-scripts
npm run typecheck
npm run build
npm run test:runtime
npm start
```

The Docker server-build stage intentionally uses the native binaries included in the locked packages, disables installation lifecycle scripts, and proves native SQLite plus all emitted worker types and the backup subprocess before producing an image. Do not re-enable lifecycle scripts casually: better-sqlite3's binding.gyp triggers npm's default node-gyp rebuild even though prebuilds exist. Test native dependencies on each supported architecture before changing this policy.

The final image contains only server production dependencies, emitted JavaScript, Python sidecars, configuration, Comskip and frontend output. Native pruning retains the actually loaded architecture/libc SQLite addon, runtime JS and licenses. The fresh-process native test protects against passing only because a deleted addon was already cached in memory. tsx, esbuild, TypeScript and Vitest must not resolve in a packaged runtime smoke with `STREAMVAULT_ASSERT_PRODUCTION=1`.

## Static compression

The web build's postbuild step writes Brotli/gzip siblings for JS/CSS under `dist/assets`. Original files and Workbox revisions remain unchanged; widgets do not need this HTTP optimization. Service workers do not precache `.br`/`.gz` files as additional resources.

The server negotiates supported available encodings and preserves original MIME, immutable caching, HEAD, ETag/304 and `Vary: Accept-Encoding`. Identity remains available where permitted. Requests with byte ranges bypass compression; API, audio/video, TS, HLS and MP4 routes are untouched. Compression does not replace long-lived media delivery or Range handling.

Tests:

```bash
node --test scripts/precompress-assets.test.mjs
```

```bash
cd server
npm test -- --maxWorkers=1 --no-file-parallelism src/precompressed-assets.test.ts
node --test scripts/prune-native.test.mjs
```

## Non-root upgrade of existing data volumes

The image runs as the `node` user (UID/GID 1000). New volumes inherit the image's owned data directory. Existing volumes from older root-run deployments need an explicit, one-time ownership migration before recreation. Preserve existing filenames and permissions; this is not a data/schema migration.

Before upgrading an existing deployment:

1. Check Compose labels to identify its exact project, working directory and volume names. Do not assume those from a differently named worktree.
2. Verify no recording, finalizer, archive capture, crawl, backup or commercial-analysis job will be interrupted. Do not stop active capture merely to satisfy a rollout gate without consent.
3. Create and validate an application-consistent SQLite backup. Retain the old image tag for rollback.
4. Stop the service only at that safe point; use a short-lived root container to change ownership of the exact mounted data and recordings volumes to UID/GID 1000. Do not dereference symlinks or touch unrelated volumes. A typical operation uses `chown -R -h 1000:1000 /app/data` with both volumes mounted in their existing layout; discover their names first.
5. Start the verified image with the same Compose project/volumes. Verify the process UID, published health endpoint, database health, durable IDs/counts and artifacts, static encoding responses and emitted worker/backup behavior.

Root-owned image code is readable; writable runtime paths are `/app/data` and `/app/tmp`. Never relax volume modes to 777. A root-run rollback image can still read the migrated files; keep the validated database backup regardless.

## Multimedia slimming decision

Retain Debian's FFmpeg/ffprobe, Python/PyAV, Comskip and util-linux in the default runtime. This implementation does not replace the tested multimedia ABI with an unverified minimal build.

The installed distribution build enables SDL, OpenGL, libplacebo and device support. FFmpeg/PyAV depend on libavdevice, bringing graphics/Mesa/LLVM components. Removing only an explicit SDL declaration does not remove this transitive graph. A minimal FFmpeg build has to be paired with compatible PyAV libraries; a wheel that duplicates its own FFmpeg stack may offset expected savings.

A future reduced-media image must preserve, at minimum, the application's actual:

- MPEG-TS demux/mux, HLS and fragmented MP4, MKV/MP4 probing and remux.
- H.264/HEVC decoding and required upstream MPEG/audio codecs; libx264/AAC browser conversion; audio-only conversion.
- HTTP/HTTPS and required network protocols, bitstream filters and timestamp handling.
- Subtitle extraction and conversion, scaling/resampling and the filters used by archive seam verification.
- Packet-aware PyAV demux/mux/stitch semantics, FFmpeg subprocess handling and Comskip's linked ABI.
- Synthetic fixture generation used by packaged media tests (including lavfi and test codecs), or a separate complete test-tool stage.

Require the complete packaged server/media and Python suites on ARM64/AMD64, missing-library checks, real commercial analysis, and physical iPhone/TV playback acceptance before changing the default. Measure total image size and duplicated libraries rather than promising a reduction from a configure flag list alone.

## Maintenance gates

Use exact lockfile installs and digest-pinned Node/Comskip provenance. Both npm trees are audited including build/test tooling, not only production dependencies. Do not force unsupported peer dependencies. Keep architecture-specific packaged runtime smokes and compare before/after image size, startup, memory and representative workloads separately; a faster typechecker is not a claimed playback speedup.
