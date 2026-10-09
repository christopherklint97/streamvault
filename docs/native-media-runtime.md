# Native media runtime

The Docker image builds upstream **FFmpeg 9.0.2**, **PyAV 19.0.1**, and
**Comskip `a140b6ac8bc8f596729e9052819affc779c3b377`** in a disposable native
build stage. `/usr/bin/python3` remains the live packet worker's entry point.
PyAV is built from source against the exact `/opt/media` FFmpeg libraries used
by `ffmpeg`, `ffprobe`, and Comskip; prebuilt PyAV wheels with a separate bundled
FFmpeg are not used. No compiler, development header, pip, or build venv is copied
into the non-root runtime.

## Reproducible inputs and authenticity

- `Dockerfile` pins the Node base by version and digest and Debian main/security
  package resolution to `20261009T000000Z` snapshots. APT archive signatures and
  package hashes remain mandatory. Only snapshot expiry checking is disabled.
  The slim base has no CA trust store, so the initial signed APT transaction uses
  HTTP; after installing CA certificates the same snapshot sources use HTTPS.
- `build/media/sources.env` pins upstream archive SHA-256 hashes, release version,
  Comskip revision, and `SOURCE_DATE_EPOCH`. FFmpeg's detached signature is checked
  against the vendored upstream release key and exact fingerprint
  `FCF986EA15E6E293A5644F10B4322F04D67658D8` on **every uncached source fetch**.
- FFmpeg sources/signature originate from `https://ffmpeg.org/releases/` and the
  key from `https://ffmpeg.org/ffmpeg-devel.asc`. PyAV's source hash is the PyPI
  `av/19.0.1` release metadata hash. Comskip's archive is pinned to its upstream
  GitHub commit, not a moving branch. Its upstream HEAD was still this revision
  when checked on 2026-10-09; there is no newer upstream commit to claim.
- `build/media/python-build-requirements.txt` pins and hashes source-wheel build
  tools for Python 3.13 on ARM64 and AMD64. Build isolation and dependency resolution
  are disabled for the PyAV source-wheel build. These tools never enter runtime.
- `/opt/media/evidence/` retains signature status, source lock, Python build lock,
  configure output, and build/runtime Debian package inventories. The runtime
  `/opt/media/manifest.json` records the native versions; `COMSKIP_REVISION` carries
  the full actual upstream revision used by the server's detector metadata.
  `COMSKIP_PATH=/opt/media/bin/comskip` explicitly connects the application's
  commercial-analysis worker to that binary; the native gate verifies the
  effective server path, not merely a successful PATH lookup.
- Comskip is that pinned upstream revision **plus a local API-only compatibility
  patch**, retained with its C regression gate in `evidence/comskip-compat/`.
  FFmpeg removed `AVCodecContext.ticks_per_frame`; the patch uses the documented
  `AV_CODEC_PROP_FIELDS` replacement, preserves Comskip's MPEG-1 override, and
  obtains whole-frame duration from decoder/demuxer frame rates rather than the
  now-unused decoder `time_base`. Missing usable frame rates fail closed. The
  build checks field/frame ticks, 25 fps and NTSC fractional rates, demuxer-rate
  fallback, and missing-rate rejection before compiling Comskip. Source patching
  checks the exact upstream file hash and expected replacement counts. The
  classifier, commercial thresholds, and `espn.ini` are not changed.

This pins source/dependency resolution, not a claim that image tar bytes are
bit-for-bit identical across architectures or BuildKit versions. Deliberately
refresh snapshots/hashes when updating security or native dependencies.

## Capabilities and boundaries

All FFmpeg built-in codecs, demuxers, muxers, protocols, filters, and bitstream
filters are retained (there is no `--disable-everything` whitelist). External
libraries add x264/x265, AV1, VPx, common audio/image codecs, libass subtitle
rendering, teletext, scaling/resampling, and GnuTLS HTTPS. The application gate
requires H.264/HEVC/MPEG-2/AAC/AC-3/E-AC-3/DTS decode, H.264/AAC transcode,
MPEG-TS/HLS/MP4/Matroska, SRT/WebVTT/DVB/DVD subtitles, HTTPS, and the actual
seam-repair and live bitstream filters. FFplay and Comskip's unused GUI are not
built; the server only uses headless processes. Nonfree libraries are not enabled.

Commercial accuracy is **not** a native upgrade acceptance claim. The existing
`espn-v1` configuration and detector settings are unchanged; the gate verifies
that Comskip can execute and decode an isolated synthetic sample, not that its
commercial predictions match real channel content.

FFmpeg 9 removes the deprecated global `-vsync` option. Archive decoded-frame
inventories, terminal-damage checks, and frame-accurate seam transcodes use
`-fps_mode:v passthrough` instead, preserving the prior `-vsync 0` semantics
without frame duplication or dropping. The synthetic seam regression retains
its exact decoded-frame-count, AAC-payload, overlap-offset, and raw-file checks.

## Build and gates

```sh
# Use a bounded builder; make and native source compilation are serial and nice 15.
docker buildx build --builder streamvault-latest --load \
  -t streamvault-latest:media-candidate .

# Default-user runtime gate; no host or production data is mounted.
docker run --rm --cpus=1 --memory=768m --pids-limit=256 \
  streamvault-latest:media-candidate /usr/bin/python3 /app/scripts/smoke-native-media.py

# Packaged Node imports.
docker run --rm --cpus=1 --memory=768m --pids-limit=256 \
  streamvault-latest:media-candidate node /app/scripts/smoke-runtime.mjs

# Source/media/Python suites need architecture-matching source dev dependencies.
# The helper uses the checkout owner's UID, writable fresh scratch, and limits.
bash scripts/test-packaged-source.sh streamvault-latest:media-candidate "$PWD"
```

The native gate also runs during Docker build **after `USER node`**. It fails on
old native versions, ABI mismatches or bundled PyAV libraries, missing application
capabilities, missing Comskip FFmpeg linkage, root execution, or runtime compilers.
It performs a real H.264/AAC PyAV decode and template remux, FFmpeg HLS readback,
fragmented-MP4 filtered transcode, subtitle extraction, and Comskip decode.
It is intentionally independent of production data and upstream media services.

For a test-first old-image comparison, mount only the gate script read-only into
a disposable container using the exact old image ID, then run that same gate on
the candidate. Never execute this diagnostic in, restart, or mount data from the
production container.
