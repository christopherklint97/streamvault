# Third-party notices

StreamVault's own code is MIT-licensed (see `LICENSE`). The Docker image
(`ghcr.io/christopherklint97/streamvault`) also contains third-party software
under other licenses. Some of it is GPL, so the image **as a whole is
distributed under the terms of the GNU GPL, version 2 or later**, for the parts
that are GPL. This file lists those components and where their exact source
code is.

Inside the image this file, the license texts and the native build recipe are
in `/usr/share/doc/streamvault/`:

| Path | Contents |
| --- | --- |
| `LICENSE` | StreamVault (MIT) |
| `THIRD_PARTY_NOTICES.md` | This file |
| `SOURCE` | The StreamVault commit the image was built from, and its source URL |
| `licenses/` | FFmpeg (`COPYING.GPLv2`, `LICENSE.md`), `Comskip-LICENSE`, `PyAV-LICENSE` |
| `licenses/frontend/` | License files of every package bundled into the web frontend (`INDEX.tsv` lists them) |
| `source/` | `build-native-media.sh`, `sources.env` (versions and SHA-256 pins), the Python build lock, the FFmpeg release key, the Comskip patch shim, and `fetch-media-sources.sh` |

`/opt/media/evidence/` additionally holds FFmpeg's configure output
(`config.h`, `config.mak`), the signature check result, and the Debian
build and runtime package inventories (`build-packages.tsv`,
`runtime-packages.tsv`).

## Native media stack (built from source in the image)

Built by `scripts/build-native-media.sh` from the archives pinned in
`build/media/sources.env`. Every archive is checked against its SHA-256; the
FFmpeg tarball is also checked against its upstream OpenPGP signature.

| Component | Version | License | Source |
| --- | --- | --- | --- |
| FFmpeg (`ffmpeg`, `ffprobe`, `libav*`) | 9.0.2 | **GPL-2.0-or-later** for this build (`--enable-gpl`, linked with x264 and x265); FFmpeg itself is LGPL-2.1-or-later | <https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz> (SHA-256 `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`, signed by `FCF986EA15E6E293A5644F10B4322F04D67658D8`) |
| Comskip | commit `a140b6ac8bc8f596729e9052819affc779c3b377`, **modified** | **GPL-2.0** | <https://github.com/erikkaashoek/Comskip/tree/a140b6ac8bc8f596729e9052819affc779c3b377> (archive SHA-256 `5563d65c0cc5f76883e26b9e460348b4826cc496d10f8d53b25e7648e47f87c2`). Modification: FFmpeg 9 API compatibility shim, `scripts/comskip-ffmpeg-compat.h` applied by `scripts/patch-comskip-ffmpeg.py` (see `docs/native-media-runtime.md`) |
| PyAV (`av`) | 19.0.1 | BSD-3-Clause (built against the GPL FFmpeg above) | <https://files.pythonhosted.org/packages/90/bc/a2a40e503250fe5d4174471911828f31658864eb69a8a7cb960c715e17b7/av-19.0.1.tar.gz> (SHA-256 `08674930eaf1af78a3ed8f93d3ba49383323b3a867e84349d9c399e36f7497da`) |

FFmpeg configure flags (from `build-native-media.sh`): `--enable-shared
--disable-static --disable-debug --disable-doc --disable-ffplay --enable-gpl
--enable-gnutls --enable-libx264 --enable-libx265 --enable-libvpx
--enable-libaom --enable-libdav1d --enable-libass --enable-libfreetype
--enable-libfontconfig --enable-libharfbuzz --enable-libmp3lame --enable-libopus
--enable-libvorbis --enable-libtheora --enable-libwebp --enable-libopenjpeg
--enable-libsoxr --enable-libzimg --enable-libzvbi`. No nonfree components are
enabled.

Cython, setuptools, wheel and packaging (pinned in
`build/media/python-build-requirements.txt`) are used only to build PyAV and
are not in the image.

## Debian packages

The image is based on `node:26.11.1-trixie-slim` (Debian 13). Its packages,
including the shared libraries FFmpeg links to, come from the Debian snapshot
`20261009T000000Z` (`snapshot.debian.org/archive/debian/20261009T000000Z/` and
`.../debian-security/20261009T000000Z/`). GPL-licensed libraries among them
include **libx264** (`libx264-164`, GPL-2.0-or-later) and **libx265**
(`libx265-215`, GPL-2.0-or-later). The full list of installed packages and
versions is `/opt/media/evidence/runtime-packages.tsv`; each package's license
is in `/usr/share/doc/<package>/copyright`. Their source packages for exactly
those versions are available from the same snapshot, for example:

```bash
# in a Debian trixie container with deb-src entries for the snapshot above
apt-get source libx264-164=<version> libx265-215=<version>
```

## Node.js and npm packages

| Component | License | Where |
| --- | --- | --- |
| Node.js 26.11.1 (base image) | MIT, with bundled third-party licenses | <https://github.com/nodejs/node/blob/v26.11.1/LICENSE> |
| Server dependencies (`express`, `better-sqlite3` incl. SQLite, `cors`, `undici` and their dependencies) | MIT and other permissive licenses (SQLite is public domain) | `/app/node_modules/*/` in the image, each with its own license file; versions in `server/package-lock.json` |
| Frontend bundle (`preact`, `zustand`, `hls.js`, `mpegts.js` and their dependencies) | MIT, Apache-2.0 (`hls.js`, `mpegts.js`) | `/usr/share/doc/streamvault/licenses/frontend/`; versions in `package-lock.json` |

## Corresponding source

- **Release images (`X.Y.Z`, `X.Y`, `latest`)**: every `v*` GitHub Release at
  <https://github.com/christopherklint97/streamvault/releases> has the exact
  FFmpeg, PyAV and Comskip source archives the image was built from, the FFmpeg
  signature, the Comskip patch shim, the build script and the Dockerfile
  attached, with a `SHA256SUMS` file.
- **`edge` and `sha-<commit>` images**: `/usr/share/doc/streamvault/SOURCE`
  names the commit. That commit's `Dockerfile`, `scripts/build-native-media.sh`
  and `build/media/sources.env` pin the exact upstream archives by URL and
  SHA-256. `scripts/fetch-media-sources.sh OUTDIR` from the same commit
  downloads and verifies them.
- **Written offer**: for at least three years after we last distribute a given
  image, we will provide the complete corresponding source for the GPL
  components in it (including the Debian source packages it uses) to anyone who
  asks. Open an issue at <https://github.com/christopherklint97/streamvault/issues>
  naming the image tag or digest.
