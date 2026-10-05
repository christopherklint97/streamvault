# Packet-aware live presentation spike (standalone, fail closed)

**Not enabled in StreamVault.** The existing server live HLS path at `server/src/live-buffer.ts` still restarts FFmpeg for every upstream session and can republish the replay overlap. Do not call that route fixed, serve this artifact as a production replacement, or deploy this branch. Archive/show capture and legacy TS are unchanged. No physical iPhone, Samsung, or desktop player acceptance was performed.

## Run locally

Requires Python 3, PyAV (`python3-av`), and FFmpeg. On this Pi, Python 3.13 / PyAV 14.2.0 and FFmpeg 7.1.5 were available. The current Docker runtime installs FFmpeg but **not Python/PyAV**; no sidecar package or deployment was added.

```sh
python3 -m unittest discover -s prototypes/live_packet_continuity -v
python3 prototypes/live_packet_continuity/stitch.py \
  --hls --output /home/christopherklint/.hermes/cache/scratch/live-eof-samples/local-continuity-hls \
  /home/christopherklint/.hermes/cache/scratch/live-eof-samples/first.ts \
  /home/christopherklint/.hermes/cache/scratch/live-eof-samples/second.ts
```

Use a **new, absent** output path. `--hls` streams a single PyAV TS mux into one persistent FFmpeg HLS stream-copy worker (2 s requested segments, 12-entry sliding playlist, `delete_segments+temp_file+independent_segments`). No `EXT-X-DISCONTINUITY` is introduced; segments start at keyframes, while unique non-IDR media inside a segment stays in the existing decoder chain. Omit `--hls` and use a `.ts` output for a full finite inventory. Inputs are only local files; they are never fetched from a provider. The standalone HLS artifact is **not** the authenticated `/api/live/:id/index.m3u8` plus signed `/segment/:id.ts` HTTP contract and is not hooked into the application.

The matcher retains a bounded rolling digest/PTS/DTS/keyframe history (2,048 packets per track), withholds one terminal video packet, and requires an unambiguous ordered, dual-track matched run of at least eight packets each at one uniform 90-kHz timestamp shift. It consumes the complete overlap through both committed tails before exposing any replacement media. The withheld terminal picture is emitted only after an exact or byte-prefix replacement at the same normalized PTS/DTS and keyframe state. Everything after the overlap gets the same timestamp shift, including non-IDR pictures and AAC. A missed duplicate, shifted audio, absent match, ambiguous static sequence, incompatible replacement, missing timestamps, codec mismatch, or DTS regression/gap aborts the presentation; it **never appends an unverified raw new session**. On failure the standalone HLS directory is cleared and replaced with an `UNSAFE` marker, not a playlist.

Limits: 2–8 TS files, 64 MiB/file and 192 MiB total input, at most 4,096 packets/32 MiB/30 s of wall time for overlap probing, one bounded history ring per track, one video-packet publishing lag. The probe timer cannot interrupt a blocked upstream `next()` call; this implementation only accepts finite local files. Rolling HLS has a bounded segment **count**, not a hard realtime bytes/disk ceiling. The inputs and worker are deliberately finite; continuous production ingest, stall detection, capacity admission, cancellation, HTTP ticketing, and retirement are **not implemented**.

## Verified local media gates

`python3 -m unittest discover -s prototypes/live_packet_continuity -v`: **19 passing** (unit/adversarial + generated H.264/AAC media + captured seam). The source captures are read-only. Tests generate additional 12-second H.264 B-frame/AAC TS inputs locally with a repeated 60-picture prefix, audio overlap and a non-IDR continuation. Output packet order/payload/PTS/DTS equals the unbroken generated source and both TS and HLS strictly decode with FFmpeg (`-xerror -err_detect explode`), with empty decode stderr. Synthetic negative cases include one corrupted duplicate, missing middle packet, audio offset conflict, repetitive ambiguous A/V, incompatible terminal replacement, third repeated session, post-proof timestamp regression/gap, resource caps, and failure cleanup.

Captured seam inventory: **2,946 H.264 + 4,724 AAC** packets in stitched TS, exactly the selected ordered source payloads: first 2,515 video / 4,049 AAC, then second video index 415 onward / audio index 762 onward. The committed overlap is **415 video and 762 AAC**; the duplicate counter reports 416 video because it additionally counts replacement of the withheld incomplete terminal packet. First unique replay video is **non-keyframe** and is present in HLS segment `35.ts` in the observed sliding output. Continuous DTS steps are 3,003 video / 1,920 audio ticks; sorted PTS steps match, with no gap. The retained HLS playlist had media sequence 31, 12 entries and 13 files (FFmpeg retains one extra segment): no discontinuity, all segment first pictures marked keyframe, independent first segment strictly decoded, and HLS strictly decoded for 15 seconds across the seam. The captured TS strictly decoded through 94 seconds across the seam. The **last video packet of the second finite capture is truncated**; strict full-playlist FFmpeg decode fails with exit **183** and a terminal H.264 macroblock/bytestream error. That known, unrelated truncation is not fixed or presented as clean end-of-file.

On the Pi, one captured HLS run: **2.792 s wall**, **0.907 s Python CPU**, **0.356 s FFmpeg child CPU**, **99,056 KiB parent peak RSS**, **71,408 KiB child peak RSS**, **12,755,988 bytes retained across 13 segments**. Finite local-file throughput excludes provider reconnect timing, concurrent channels, network I/O, runtime memory overlap, HTTP readers, and battery/device behavior.

## Unmet integration/acceptance gates

- StreamVault live route still publishes replayed media from independent FFmpeg workers. Replacing that with a persistent packet-aware ingest needs an installed/runtime-compatible PyAV sidecar (or equivalent), per-channel bounded staging/segment bytes/free-disk enforcement, shared worker lifecycle, abort/retirement/shutdown, and authenticated signed segment routing. No frontend/server route was changed; no server/client regression suite was claimed for this spike.
- If the upstream replays ~14–16 s at realtime pace and viewers only have ~2–4 s playable lead, no remuxer can hide the missing-media delay. The observed separate burst sample may help **one** occasion, not a guarantee. A real arrival-time vs playable-buffer study and repeated EOFs on physical iPhone/Samsung/desktop are required before any smooth-playback claim.
- Unsupported tracks (including subtitles), codec/timestamp changes, unknown ambiguous overlap, or inability to replace a truncated terminal packet must take explicit legacy fallback / unavailable handling in a later integration, never a silent "fixed" label. This spike fails closed rather than selecting a fallback itself.
