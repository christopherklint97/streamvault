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
| `SOURCE` | The StreamVault commit the image was built from, its media pin hash, and where the corresponding source bundle is |
| `licenses/` | FFmpeg (`COPYING.GPLv2`, `LICENSE.md`), `Comskip-LICENSE`, `PyAV-LICENSE` |
| `licenses/frontend/` | License files of every package bundled into the web frontend (`INDEX.tsv` lists them) |
| `source/` | `build-native-media.sh`, `sources.env` (versions and SHA-256 pins), `debian.env` (Debian snapshot), `runtime-packages.txt` (Debian runtime packages), the Python build lock, the FFmpeg release key, the Comskip patch shim, `fetch-media-sources.sh` and `media-pin-hash.sh` |

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

The image is based on `node:26.11.1-trixie-slim` (Debian 13). The packages in
`build/media/runtime-packages.txt` and their dependencies, including the shared
libraries FFmpeg links to, come from the Debian snapshot in
`build/media/debian.env` (`20261009T000000Z`:
`snapshot.debian.org/archive/debian/20261009T000000Z/` and
`.../debian-security/20261009T000000Z/`). GPL-licensed libraries among them
include **libx264** (`libx264-164`, GPL-2.0-or-later) and **libx265**
(`libx265-215`, GPL-2.0-or-later); others are under the LGPL (for example
GnuTLS, LAME, libsoxr, zvbi, FriBidi, GLib). The full list of installed packages
and versions is `/opt/media/evidence/runtime-packages.tsv`; each package's
license is in `/usr/share/doc/<package>/copyright`.

The source bundle (below) contains the Debian source package (`.dsc`, orig and
Debian tarballs) of every package that apt adds to the base image and whose
Debian copyright file names a GPL, LGPL or AGPL license for any of its files,
fetched from the same snapshot by `apt-get source`. `debian-packages.tsv` in the
bundle lists every added package per architecture with its source package and
the GPL-family licenses found; `debian-sources.txt` lists the source packages
included.
Packages that already come with the `node:26.11.1-trixie-slim` base image
(Debian's base system, such as `libc6` and `bash`) are not repackaged in the
bundle; `/opt/media/evidence/runtime-packages.tsv` names their versions, and
their Debian source packages are on snapshot.debian.org.

## Node.js and npm packages

| Component | License | Where |
| --- | --- | --- |
| Node.js 26.11.1 (base image) | MIT, with bundled third-party licenses | <https://github.com/nodejs/node/blob/v26.11.1/LICENSE> |
| Server dependencies (`express`, `better-sqlite3` incl. SQLite, `cors`, `undici` and their dependencies) | MIT and other permissive licenses (SQLite is public domain) | `/app/node_modules/*/` in the image, each with its own license file; versions in `server/package-lock.json` |
| Frontend bundle (`preact`, `zustand`, `hls.js`, `mpegts.js` and their dependencies) | MIT, Apache-2.0 (`hls.js`, `mpegts.js`) | `/usr/share/doc/streamvault/licenses/frontend/`; versions in `package-lock.json` |

## Corresponding source

The complete corresponding source of the GPL and LGPL components of every
published image (`sha-<commit>`, `edge`, `X.Y.Z`, `X.Y`, `latest`) is
distributed next to the image, in two identical copies:

- the OCI artifact `ghcr.io/christopherklint97/streamvault-sources:<pin>`, in
  the same registry as the image;
- the GitHub Release `media-sources-<pin>` (a pre-release) at
  <https://github.com/christopherklint97/streamvault/releases>.

`<pin>` is the image's media pin hash: 16 hex digits computed by
`scripts/media-pin-hash.sh` over everything the native media stack is built
from (`build/media/*`, the build script, the Comskip patch files, the bundle
scripts and the pinned base image). Every image carries it in the
`io.github.christopherklint97.streamvault.source-bundle` label and in
`/usr/share/doc/streamvault/SOURCE`. CI creates the bundle once per pin hash
and does not publish an image until its bundle exists in both places.

The bundle contains:

- the exact FFmpeg source archive with its upstream `.asc` signature, the
  Comskip archive and the PyAV sdist;
- the Comskip compatibility shim (`comskip-ffmpeg-compat.h`), the script that
  applies it (`patch-comskip-ffmpeg.py`) and its regression test;
- `build-native-media.sh`, the `Dockerfile`, the pin files (`sources.env`,
  `debian.env`, `runtime-packages.txt`, the Python build lock, the FFmpeg
  release key) and the scripts that assembled the bundle;
- `debian-sources.tar`: the Debian source packages described above;
- `SHA256SUMS` over all of it, and `MEDIA_PIN_HASH`.

To fetch it, find the bundle reference of the image (the multi-arch index
carries it as an annotation, the image config as a label), then pull it:

```bash
image=ghcr.io/christopherklint97/streamvault:latest
bundle=$(docker buildx imagetools inspect --raw "$image" |
  jq -r '.annotations["io.github.christopherklint97.streamvault.source-bundle"]')
# or, for a pulled image:
#   docker image inspect --format '{{ index .Config.Labels "io.github.christopherklint97.streamvault.source-bundle" }}' "$image"
pin=${bundle##*:}

# From the registry, with oras (https://oras.land)
mkdir "streamvault-sources-$pin" && cd "streamvault-sources-$pin"
oras pull "$bundle"
# or from GitHub: gh release download "media-sources-$pin" --repo christopherklint97/streamvault

sha256sum --check SHA256SUMS
```

The Git commit named in `SOURCE` holds StreamVault's own source and the same
build recipe; `scripts/build-source-bundle.sh` in it rebuilds the bundle.
