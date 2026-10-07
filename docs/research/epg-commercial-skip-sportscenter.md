# StreamVault EPG Recording and Commercial Skip Research

**Test case:** US linear ESPN, `SportsCenter`  
**Research date:** 2026-09-20  
**Scope:** research and architecture only; no recording rule or production code was created.

## Decision

Proceed, but build it as two independent systems:

1. **Reliable programme/series scheduling from EPG data.**
2. **Non-destructive commercial detection that produces a skip map.**

The first release should record the original programme, analyze it after capture, and let the player seek over detected commercial intervals. It should not physically remove commercials or attempt zero-delay live skipping by default. This preserves the source when a detector makes a mistake and allows detection to be retuned without recording the show again.

For the tested ESPN source, SCTE-35 cannot be the primary detector: the live StreamVault feed currently exposes a two-stream MPEG-TS programme—H.264 video and AAC audio—with no SCTE-35/data PID visible in the PMT. Comskip-style content analysis is therefore the practical first detector. Marker support should still be implemented because other sources may preserve it.

## What the deployed StreamVault already has

- Recording CRUD, one-off recording from an EPG programme, title-based recording rules, padding, retention, and a 60-second scheduler tick.
- A maximum of two concurrent FFmpeg recordings.
- Xtream short-EPG ingestion and an XMLTV parser.
- A recordings view and direct playback of completed fragmented MP4 files.

Relevant implementation locations:

- `server/src/recording-scheduler.ts`
- `server/src/recorder.ts`
- `server/src/xtream.ts`
- `server/src/parsers.ts`
- `server/src/db.ts`
- `src/stores/recordingStore.ts`
- `src/pages/Recordings.tsx`
- `src/hooks/usePlayer.ts`

## Findings from the current ESPN feed

### Channel and transport

The deployed database contains two equivalent US ESPN candidates:

- `live_71936` — `US - ESPN HD ◉`
- `live_1015944` — `US - ESPN 1 HD ◉`

Both returned the same programme lineup during inspection. `live_71936` should be the initial test channel so the experiment uses one source consistently.

A live `ffprobe` inspection of `live_71936`, plus spot checks of the other ESPN variants, found:

- MPEG-2 transport stream container
- 1280×720 H.264 video
- stereo AAC audio at 48 kHz
- one programme with exactly two elementary streams
- no visible SCTE-35 or generic data stream/PID

This does not prove ESPN never originates SCTE-35. It proves that the particular provider path currently delivered to StreamVault does not expose it in the sampled PMT. An upstream relay or remuxer may have removed it; commercial detection must therefore operate without assuming markers survive.

### SportsCenter EPG sample

Refreshing the provider’s ten-item short EPG produced two upcoming generic `SportsCenter` airings on the chosen channel:

- 2026-09-20 23:00–00:00 UTC
- 2026-09-21 00:00–00:30 UTC

They have the same title and generic description but are separate transmissions. Earlier cached data also contained several consecutive `SportsCenter` blocks. ESPN’s own schedule likewise lists multiple same-day `SportsCenter` airings and separately names `SportsCenter with Scott Van Pelt`.[7][8]

Consequences:

- Same title and description do **not** mean duplicate content for a rolling sports-news programme.
- Back-to-back same-title blocks must remain separate airings unless the user explicitly chooses to merge them.
- Exact-title `SportsCenter` should exclude `SportsCenter with Scott Van Pelt`.
- An optional “include editions” mode should match an explicit family of accepted titles, not arbitrary substring matches. ESPN also uses specials and branded variants, so `contains("SportsCenter")` is too broad.[11][12]

## Gaps that must be fixed before series recording is trustworthy

### 1. EPG data is being discarded

XMLTV can carry subtitles/episode titles, multiple episode-number systems, `previously-shown`, `premiere`, `new`, categories, and other metadata.[1] The current parser and database retain only channel, title, description, start, stop, and one category.

The Xtream short-EPG response already includes `id` and `epg_id`, but `fetchXtreamShortEpg()` discards both. Those may be the best available airing identifiers and should be preserved before relying on title/time heuristics.

Store at least:

- `source` and source channel ID
- upstream airing/event ID
- provider EPG ID
- title and subtitle
- all episode-number `{system, value}` pairs
- series identifier/CRID, if present
- episode/content identifier, if present
- categories
- scheduled start/stop and timezone/offset provenance
- `previously_shown`, `premiere`, `new`, and provider-specific `live` as tri-state values
- first-seen, last-seen, and schedule revision timestamps
- raw metadata JSON or the raw XML programme fragment for later reparsing

`<previously-shown/>` means the programme has aired before, but its absence does not prove that an airing is new. XMLTV’s `<new/>` is narrower than a general “new episode” flag. Missing information must therefore remain **unknown**, not become false.[1]

### 2. The guide horizon is too fragile

Xtream fetching is hard-coded to `limit=10`. A full EPG crawl runs once per day, while recording rules are matched hourly against only the next 24 hours. On ESPN, ten events covered only part of the day during inspection. A later `SportsCenter` can therefore be absent from the database even though the rule checker is running.

Required change:

- Refresh EPG for every enabled recording-rule channel before rule reconciliation.
- Request a larger supported short-EPG limit and measure what the provider actually returns.
- Reconcile the entire available horizon, ideally at least 3–7 days where source data permits.
- Keep the daily full-catalog crawl for browsing, but decouple it from the higher-priority rule-channel refresh.
- Retry failed rule-channel refreshes with bounded backoff and report guide freshness in the UI.

### 3. Airing, series, and content identity are conflated

Use three distinct concepts:

- **Rule match:** does this event belong to the requested programme family?
- **Airing identity:** is this the same scheduled transmission after an EPG revision?
- **Content identity:** is this a repeat of the same episode/content?

Established DVRs similarly distinguish series links from episode/content IDs and fall back cautiously when metadata is generic.[2][4] Schedule-independent content reference identifiers are specifically intended to survive broadcast-time changes.[6]

Recommended key hierarchy:

1. Stable upstream event ID for airing reconciliation.
2. Stable episode/content ID for repeat suppression.
3. Recognized provider episode identifier.
4. Strong fallback: normalized title + non-empty subtitle + original-air metadata.
5. If only a generic title/description exists, identity is unknown; record the airing rather than silently suppressing it.

For `SportsCenter`, default to **every matching airing**. Optional policies can include first airing per day/daypart, but they must be labeled as heuristics rather than episode deduplication.

### 4. Schedule revisions currently create duplicates

Current duplicate detection compares channel and start times within two minutes. If an event moves by more than two minutes, a second recording may be inserted while the old one remains.

Add a stable `airing_key` and reconcile pending jobs after every successful guide refresh:

- Update the existing pending recording when start/stop changes.
- Do not cancel on one missing refresh; require a later successful confirmation.
- Apply a lock window shortly before start so late guide churn cannot incorrectly remove an imminent/active recording.
- Never mutate the schedule of an already active capture except to extend its end time under a defined policy.

### 5. Rule matching is too limited

The public type allows `exact | contains`, and the API accepts `startsWith`, but the scheduler treats every non-exact value as `contains`. Replace this with an explicit, tested matcher model:

- exact title
- explicit accepted-title family
- optional normalized prefix
- never an implicit regex from user text
- channel scope: one channel, a user-selected channel set, or a network family
- edition/special inclusion flags
- airing policy and repeat policy

For the first SportsCenter rule:

- channel: `live_71936`
- accepted title: exact `SportsCenter`
- policy: every airing
- padding: 2 minutes before, 5 minutes after initially
- no “new only” filtering because the available provider data does not establish it
- do not include `SportsCenter with Scott Van Pelt` until explicitly enabled

## Commercial detection research

### SCTE-35 marker path

SCTE-35 is a timed cueing mechanism used for advertising breaks, advertising content, programme boundaries, and other distribution events; it signals opportunities and boundaries rather than proving that every marked interval is an ordinary commercial.[13] In MPEG-TS the cue table is carried on PID(s) referenced by the programme map. In HLS, packagers commonly expose it through `EXT-X-CUE-OUT`, `EXT-X-CUE-IN`, continuation tags, or `EXT-X-DATERANGE` attributes.[14][15]

Implementation rules:

- Inspect every source at capture start for SCTE-35/data PIDs or HLS cue tags.
- Parse the semantic event type, not merely “a cue exists.”
- Save marker-derived intervals and the raw cue payload for debugging.
- Do not automatically equate blackouts, chapters, provider promos, or programme boundaries with removable ads.
- Preserve markers when possible; output pipelines can explicitly remove SCTE-35, so an absence after remuxing may be self-inflicted.[15]

The current recorder explicitly maps only the first video and first audio streams and transcodes to MP4. That guarantees any separate cue/data stream is discarded even if another source provides one.

### Content-analysis path

Comskip analyzes recordings using black frames, silence, aspect-ratio changes, logo presence, scene-change rate, captions, and tunable heuristics; it can process MPEG-TS and can follow an actively growing recording.[16][18] Its own tuning guide warns that results depend on broadcaster style and that some recordings may not contain enough reliable segmentation evidence.[17]

This is appropriate for an ESPN prototype because:

- the tested source is H.264/AAC MPEG-TS;
- ESPN normally presents a persistent bug/logo and structured breaks, useful as signals;
- SportsCenter also contains rapid highlight edits, stingers, full-screen graphics, sponsor integrations, and programme promos, which can resemble commercials and make single-signal detection unsafe.

Recommended detector chain:

1. **Marker detector** when SCTE-35/HLS markers exist.
2. **Comskip analyzer** with an ESPN-specific profile.
3. **FFmpeg corroboration/debug features** such as black-frame and silence intervals, not as a standalone commercial classifier.[19]
4. Combine detector outputs into intervals with a method and confidence, rather than one irreversible yes/no result.

Do not start with a custom ML model. It adds training-data, inference, explainability, and Pi resource costs before the simpler baseline has been measured.

### ARM64 feasibility probe

Comskip revision `a140b6a` was built successfully on this Raspberry Pi as a native ARM64 binary using Debian 13, the packaged `libargtable2`, and FFmpeg 7.1 development libraries. The upstream Alpine Dockerfile did **not** build unchanged on ARM64 because its bundled 2005 `argtable2` `config.guess` could not identify `aarch64`; StreamVault should use Debian's maintained ARM64 package instead of copying that Dockerfile.

The resulting temporary research image (`sha256:9b93d4cc7577c9fa2448021ec20288f64188d08375640d807d85d936f483586b`) parsed a 75.12-second, 33 MB sample from the exact ESPN channel successfully while constrained to one CPU and 512 MiB RAM. It decoded 2,174 frames in 17.13 seconds at 126.91 fps—about 4.39× real time, or roughly 13.7 minutes of analysis per recorded hour at that measured rate. The short non-SportsCenter sample contained no detected break and used no tuned INI file, so this validates build/codec/performance feasibility only, not commercial-detection accuracy.

The research image is about 499 MB and is not proposed as the production packaging. A production multi-stage build should copy the binary into the existing Debian-based StreamVault server image and add only the required runtime library, then pin the Comskip source revision and profile version.

### Keep the source and create a skip map

Add a `commercial_segments` table or versioned JSON document containing:

- recording ID
- start/end seconds
- detector (`scte35`, `comskip`, `manual`, or combined)
- confidence
- detector/profile version
- review state
- created/updated timestamp

Add an analysis state independent of recording state:

- `not_requested`
- `queued`
- `analyzing`
- `ready`
- `review_needed`
- `failed`

The player should seek over a ready interval, show “Commercial skipped · Undo,” and prevent a seek loop if the user returns to the interval. Users must be able to disable automatic skipping per recording and globally.

Retain the original recording. Comskip’s normal output is a small cut/skip description; it does not require modifying the recording.[18] This is safer and cheaper than generating a second media file.

### Recording container and CPU implications

The current recorder re-encodes video with `libx264 -preset ultrafast` and AAC despite the tested source already being H.264/AAC. It is constrained to two FFmpeg threads and the StreamVault container is capped at two CPU cores and 2 GiB RAM. Running recording transcodes and commercial analysis concurrently would compete for exactly those resources.

Recommended ingest:

- Write a raw or remuxed MPEG-TS master with stream copy.
- Preserve all relevant streams/data when the source carries them.
- Use an atomic `.part` → final rename.
- Keep capture and analysis as separate jobs.
- Run at most one commercial-analysis worker, at low priority, and pause/defer it when StreamVault is actively transcoding or recording at high load.
- If browser compatibility requires MP4/HLS, create a stream-copy playback derivative after capture or serve an HLS derivative from the master; avoid a full video re-encode merely to record.

If a permanently cleaned export is added later, warn that stream-copy cuts are constrained by keyframes and can be imprecise; frame-accurate cuts require decoding/re-encoding around boundaries or the full output.[20][21]

## Live commercial skipping

Do not include it in the first release.

- Marker-driven live skipping can work only when reliable cues survive in the delivered stream.
- Content-based detection necessarily sees at least part of a break before classifying it.
- A 30–90 second delayed playback buffer can hide that detection latency, but it introduces a second live/time-shift playback mode, buffer retention, late cue handling, and recovery complexity.

First prove post-recording detection. A later phase can run Comskip against the growing TS and expose only finalized intervals behind the playback head, but it should remain experimental until false skips are negligible.

## SportsCenter validation plan

One recording is insufficient for tuning. Build a labeled sample set of at least five airings from `live_71936`:

1. A normal one-hour SportsCenter.
2. A 30-minute edition.
3. Back-to-back generic editions.
4. A weekend/postgame edition following a live event.
5. `SportsCenter with Scott Van Pelt` as an explicit title-family exclusion/inclusion test.

For each recording:

- retain the original TS;
- manually label programme, commercial, provider promo, and uncertain intervals;
- save PMT/stream inventory and any cue events;
- run the same Comskip profile and record its version/config;
- review every boundary in the StreamVault player.

Measure:

- commercial-duration recall;
- programme seconds falsely marked as commercial;
- boundary error at break start/end;
- analysis wall time, peak CPU, and memory;
- capture/playback impact while analysis runs;
- failures caused by stream reconnects or timestamp discontinuities.

Suggested rollout gates:

- **Mark-only pilot:** detection completes reliably and commercial-duration recall is useful.
- **Manual “Skip” button:** intervals are visible but not automatically jumped.
- **Auto-skip beta:** no destructive edits; an immediate Undo control; only an ESPN-tuned profile.
- **Default auto-skip:** only after several varied recordings show no programme-content false skips at the chosen confidence threshold.

The most important metric is programme content skipped incorrectly, not total advertisements removed.

## Implementation order

### Phase 1 — EPG reliability

1. Enrich programme storage and preserve upstream IDs/raw metadata.
2. Refresh enabled-rule channels independently of the daily catalog crawl.
3. Add explicit rule match/scope/airing policies.
4. Reconcile schedule revisions through stable airing keys.
5. Add guide freshness and “why this matched” diagnostics.

### Phase 2 — Lossless recording master

1. Replace always-transcode capture with TS stream-copy/raw capture where compatible.
2. Preserve all stream inventory and marker metadata.
3. Add atomic finalization, reconnect/discontinuity tests, and playback derivatives as needed.

### Phase 3 — Commercial analysis and player skip

1. Add analysis jobs and interval storage.
2. Integrate Comskip as a separate worker with an ESPN profile.
3. Add recording-detail commercial review and manual interval editing.
4. Add player skip/Undo and per-recording disable controls.
5. Keep original files and record detector versions.

### Phase 4 — Optional exports and delayed live mode

1. Add opt-in cleaned-file export with a keyframe-accuracy warning.
2. Evaluate marker-driven delayed live skipping only on sources where cue capture is verified.
3. Consider a custom classifier only if the measured Comskip baseline cannot meet the false-skip target.

## Go/no-go conclusion

**GO for implementation after the EPG/recording foundation is corrected.**

The project is feasible on the current StreamVault architecture. The main risk is not detecting some commercials; it is falsely skipping SportsCenter highlights or discussion. Non-destructive intervals, source retention, per-channel tuning, and measured rollout gates contain that risk.

The current ESPN provider feed gives enough EPG information to find generic `SportsCenter` airings, but not enough metadata for trustworthy “new episodes only” or content deduplication. The tested transport does not expose SCTE-35, so the realistic first prototype is: exact-title SportsCenter rule → lossless TS recording → post-recording Comskip analysis → reviewable skip map → player skip with Undo.

## Sources

[1] https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd — XMLTV DTD
[2] https://docs.tvheadend.org/documentation/development/xmltv/input/episode-numbering — Tvheadend XMLTV Episode Numbering
[4] https://wiki.mythtv.org/wiki/Duplicate_matching — MythTV Duplicate Matching
[6] https://www.rfc-editor.org/rfc/rfc4078.html — RFC 4078 TV-Anytime CRID
[7] https://www.espn.com/watch/series/1fc53390-aca2-4d45-9acf-c9cd2bd30b1c/sportscenter — ESPN SportsCenter Series
[8] https://www.espn.com/watch/catalog/1e25d005-84d1-42c4-9206-d1c989d4fc89 — ESPN SportsCenter with Scott Van Pelt
[11] https://espnpressroom.com/press-release/sportscenter-50-states-in-50-days-full-schedule-unveiled — SportsCenter: 50 States in 50 Days Schedule
[12] https://espnpressroom.com/press-release/march-9-espns-nfl-free-agency-coverage-kicks-off-with-over-six-hours-of-live-programming-beginning-at-noon-with-the-pat-mcafee-show-nfl-free-agency-countdown — SportsCenter Special: NFL Free Agency Countdown
[13] https://account.scte.org/standards/library/catalog/scte-35-1-digital-program-insertion-cueing-message-part-1-legacy-splice-based-and-time-based-signaling — SCTE 35-1 standard overview
[14] https://docs.aws.amazon.com/mediapackage/latest/userguide/ext-x-cue-ad-marker.html — AWS MediaPackage HLS CUE ad markers
[15] https://docs.aws.amazon.com/medialive/latest/ug/scte-35-passthrough-or-removal.html — AWS MediaLive SCTE-35 passthrough/removal
[16] http://www.kaashoek.com/files/manual.htm — Comskip manual
[17] http://www.kaashoek.com/gbpvr/tuning.htm — Comskip tuning guide
[18] https://www.comskip.org — Comskip official site
[19] https://ffmpeg.org/ffmpeg-filters.html — FFmpeg filters documentation
[20] https://trac.ffmpeg.org/wiki/Seeking — FFmpeg seeking guide
[21] https://ffmpeg.org/ffmpeg.html — FFmpeg documentation
