"""Fail-closed, bounded H.264/AAC packet presentation across TS session EOFs.

This is an offline/standalone prototype, NOT wired into StreamVault's live route.
No network input, credentials, production state, or archive paths are accepted.
"""
from __future__ import annotations

import argparse
from collections import deque
from contextlib import suppress
from dataclasses import dataclass, replace
from hashlib import sha256
from itertools import chain
from pathlib import Path
import shutil
import subprocess
import time
from typing import Iterable, Iterator


class UnsafeSeam(Exception):
    """An input cannot be proved to continue the published decoder chain."""


@dataclass(frozen=True)
class Packet:
    kind: str
    pts: int
    dts: int
    data: bytes
    keyframe: bool
    native: object = None


@dataclass(frozen=True)
class Stamp:
    pts: int
    dts: int
    digest: bytes
    keyframe: bool


def stamp(packet: Packet) -> Stamp:
    return Stamp(packet.pts, packet.dts, sha256(packet.data).digest(), packet.keyframe)


class Stitcher:
    def __init__(self, min_run: int = 8, history_packets: int = 2048,
                 max_probe_bytes: int = 32 * 1024 * 1024, max_probe_packets: int = 4096,
                 probe_seconds: float = 30):
        if min_run < 2 or history_packets < min_run or max_probe_bytes <= 0 or max_probe_packets <= 0:
            raise ValueError('invalid seam limits')
        self.min_run = min_run
        self.max_probe_bytes = max_probe_bytes
        self.max_probe_packets = max_probe_packets
        self.probe_seconds = probe_seconds
        self.history = {k: deque(maxlen=history_packets) for k in ('video', 'audio')}
        self.pending_video: Packet | None = None
        self.pending_audio: Packet | None = None
        self.duplicates = {'video': 0, 'audio': 0}
        self.sessions = 0
        self.failed = False

    def _publish(self, packets: Iterable[Packet]) -> Iterator[Packet]:
        for packet in packets:
            if packet.kind not in self.history or packet.pts is None or packet.dts is None or not packet.data:
                self.failed = True
                raise UnsafeSeam('unsupported or timestamp-less packet')
            pending = self.pending_video if packet.kind == 'video' else self.pending_audio
            previous_stamp = (stamp(pending) if pending
                              else self.history[packet.kind][-1] if self.history[packet.kind] else None)
            if previous_stamp and not 0 < packet.dts - previous_stamp.dts <= 90000:
                self.failed = True
                raise UnsafeSeam('non-continuous decode timestamps')
            if packet.kind == 'video':
                if self.pending_video:
                    previous = self.pending_video
                    self.history['video'].append(stamp(previous))
                    yield previous
                self.pending_video = packet
            else:
                # EOF can flush an incomplete ADTS frame. Keep the tail private.
                if self.pending_audio:
                    previous = self.pending_audio
                    self.history['audio'].append(stamp(previous))
                    yield previous
                self.pending_audio = packet

    def feed(self, packets: Iterable[Packet]) -> Iterator[Packet]:
        if self.failed:
            raise UnsafeSeam('stitcher already failed')
        if self.sessions == 0:
            self.sessions += 1
            yield from self._publish(packets)
            return
        self.sessions += 1
        if self.pending_video is None or self.pending_audio is None or any(len(h) < self.min_run for h in self.history.values()):
            self.failed = True
            raise UnsafeSeam('too little retained history')
        try:
            yield from self._seam(iter(packets))
        except (UnsafeSeam, OSError):
            self.failed = True
            raise

    def _seam(self, source: Iterator[Packet]) -> Iterator[Packet]:
        snapshot = {k: tuple(v) for k, v in self.history.items()}
        prefix: list[Packet] = []
        seen = {'video': [], 'audio': []}
        size = 0
        started = time.monotonic()

        def take() -> Packet:
            nonlocal size
            if time.monotonic() - started > self.probe_seconds:
                raise UnsafeSeam('seam probe deadline exceeded')
            try:
                packet = next(source)
            except StopIteration as exc:
                raise UnsafeSeam('session ended before seam proved') from exc
            if packet.kind not in seen or packet.pts is None or packet.dts is None or not packet.data:
                raise UnsafeSeam('unsupported or timestamp-less seam packet')
            size += len(packet.data)
            if size > self.max_probe_bytes or len(prefix) >= self.max_probe_packets:
                raise UnsafeSeam('seam probe budget exceeded')
            prefix.append(packet)
            if len(seen[packet.kind]) < self.min_run:
                seen[packet.kind].append(packet)
            return packet

        while any(len(v) < self.min_run for v in seen.values()):
            take()

        def candidates(kind: str) -> list[tuple[int, int]]:
            records = snapshot[kind]
            incoming = seen[kind]
            found = []
            for start in range(len(records) - self.min_run + 1):
                offset = records[start].dts - incoming[0].dts
                if all(records[start + ix].digest == sha256(p.data).digest()
                       and records[start + ix].pts == p.pts + offset
                       and records[start + ix].dts == p.dts + offset
                       and records[start + ix].keyframe == p.keyframe
                       for ix, p in enumerate(incoming)):
                    found.append((start, offset))
            return found

        video_candidates, audio_candidates = candidates('video'), candidates('audio')
        compatible = [(v, a) for v in video_candidates for a in audio_candidates if v[1] == a[1]]
        if len(compatible) != 1 or len(video_candidates) != 1 or len(audio_candidates) != 1:
            raise UnsafeSeam('overlap absent, conflicting, or ambiguous')
        (vstart, offset), (astart, _) = compatible[0]
        index = {'video': vstart, 'audio': astart}
        ready = {'video': False, 'audio': False}
        accepted: list[Packet] = []
        replacement = None
        # No new-generation packets are published until BOTH streams have reached
        # the committed tail and the withheld final picture has a full replacement.
        def check(packet: Packet):
            nonlocal replacement
            kind = packet.kind
            shifted = replace(packet, pts=packet.pts + offset, dts=packet.dts + offset)
            if index[kind] < len(snapshot[kind]):
                expected = snapshot[kind][index[kind]]
                if stamp(shifted) != expected:
                    raise UnsafeSeam('duplicate run diverged before published tail')
                index[kind] += 1
                self.duplicates[kind] += 1
            elif kind == 'video' and replacement is None:
                held = self.pending_video
                if (shifted.pts != held.pts or shifted.dts != held.dts
                    or shifted.keyframe != held.keyframe or not shifted.data.startswith(held.data)):
                    raise UnsafeSeam('withheld picture cannot be safely replaced')
                replacement = shifted
                self.duplicates['video'] += 1
                ready['video'] = True
                accepted.append(shifted)
            else:
                if kind == 'video' and replacement is None:
                    raise UnsafeSeam('unexpected video without held replacement')
                if kind == 'audio' and not ready['audio']:
                    held = self.pending_audio
                    if (shifted.pts != held.pts or shifted.dts != held.dts
                        or shifted.keyframe != held.keyframe or not shifted.data.startswith(held.data)):
                        raise UnsafeSeam('withheld audio cannot be safely replaced')
                    self.duplicates['audio'] += 1
                    ready['audio'] = True
                accepted.append(shifted)

        for packet in prefix:
            check(packet)
        while not all(ready.values()):
            check(take())
        # A simultaneous packet may already be buffered. No output escaped before
        # full dual-stream proof; resume a bounded one-packet streaming lag now.
        self.pending_video = None
        self.pending_audio = None
        shifted_tail = (replace(p, pts=p.pts + offset, dts=p.dts + offset) for p in source)
        yield from self._publish(chain(accepted, shifted_tail))

    def finish(self) -> Iterator[Packet]:
        if self.failed:
            raise UnsafeSeam('cannot finalize failed presentation')
        pending = sorted((p for p in (self.pending_video, self.pending_audio) if p), key=lambda p: p.dts)
        self.pending_video = self.pending_audio = None
        for packet in pending:
            self.history[packet.kind].append(stamp(packet))
            yield packet


def ts_packets(container) -> Iterator[Packet]:
    """Accept only one 90 kHz H.264 video and one 90 kHz AAC audio track."""
    streams = list(container.streams)
    if len(streams) != 2 or {s.type for s in streams} != {'video', 'audio'}:
        raise UnsafeSeam('requires exactly one video and one audio stream')
    by_index = {}
    for stream in streams:
        if (stream.codec_context.name != {'video': 'h264', 'audio': 'aac'}[stream.type]
            or stream.time_base.numerator != 1 or stream.time_base.denominator != 90000):
            raise UnsafeSeam('requires H.264/AAC with 90 kHz timestamps')
        by_index[stream.index] = stream.type
    for pkt in container.demux():
        if pkt.size == 0:  # PyAV synthetic EOF flush marker
            continue
        if pkt.pts is None or pkt.dts is None:
            raise UnsafeSeam('timestamp-less media packet')
        yield Packet(by_index[pkt.stream.index], pkt.pts, pkt.dts, bytes(pkt), pkt.is_keyframe, pkt)


def run(inputs: list[Path], output: Path, *, hls: bool = False) -> dict:
    """Local-file-only executable; stream-copy one uninterrupted decoder timeline."""
    import av
    if not 2 <= len(inputs) <= 8 or any(not f.is_file() or f.suffix != '.ts' for f in inputs):
        raise ValueError('requires 2-8 existing local TS files')
    sizes = [f.stat().st_size for f in inputs]
    if any(size > 64 * 1024 * 1024 for size in sizes) or sum(sizes) > 192 * 1024 * 1024:
        raise ValueError('per-session or total input byte cap exceeded')
    if output.exists():
        raise ValueError('refusing to overwrite output')
    if hls:
        output.mkdir(mode=0o700, parents=True)
        args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0',
                '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '12',
                '-hls_flags', 'delete_segments+temp_file+independent_segments',
                '-hls_segment_filename', str(output / '%d.ts'), str(output / 'index.m3u8')]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        destination = child.stdin
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        child = None
        destination = str(output)
    stitcher = Stitcher()
    counts = {'video': 0, 'audio': 0}
    opened = time.monotonic()
    try:
        with av.open(destination, 'w', format='mpegts', options={'mpegts_flags': '+resend_headers'}) as mux:
            mapped = None
            for file in inputs:
                with av.open(str(file), 'r', format='mpegts') as demux:
                    stream_list = list(demux.streams)
                    if mapped is None:
                        # Validation occurs before the first output byte.
                        valid = ts_packets(demux)
                        mapped = {s.type: mux.add_stream_from_template(s) for s in stream_list}
                    else:
                        valid = ts_packets(demux)
                    for packet in stitcher.feed(valid):
                        original = packet.native
                        original.pts, original.dts = packet.pts, packet.dts
                        original.stream = mapped[packet.kind]
                        mux.mux(original)
                        counts[packet.kind] += 1
            for packet in stitcher.finish():
                original = packet.native
                original.pts, original.dts = packet.pts, packet.dts
                original.stream = mapped[packet.kind]
                mux.mux(original)
                counts[packet.kind] += 1
        if child:
            destination.close()
            if child.wait(timeout=30) != 0:
                raise UnsafeSeam('HLS muxer exited unsuccessfully')
        return {'packets': counts, 'duplicates': stitcher.duplicates,
                'sessions': stitcher.sessions, 'seconds': round(time.monotonic() - opened, 3)}
    except BaseException:
        if child:
            child.kill()
            child.wait(timeout=5)
            with suppress(BrokenPipeError):
                destination.close()
            # A rejected seam must not leave an apparently playable manifest.
            shutil.rmtree(output)
            output.mkdir(mode=0o700)
            (output / 'UNSAFE').write_text('Packet continuity not verified; no HLS may be served.\n')
        else:
            with suppress(FileNotFoundError):
                output.unlink()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', type=Path, nargs='+')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--hls', action='store_true')
    args = parser.parse_args()
    try:
        print(run(args.inputs, args.output, hls=args.hls))
    except (UnsafeSeam, ValueError, OSError) as exc:
        # No raw media, URLs or input paths printed (even in a traceback).
        print(f'UNSAFE: {type(exc).__name__}: {exc}', file=__import__('sys').stderr)
        raise SystemExit(2) from None


if __name__ == '__main__':
    main()
