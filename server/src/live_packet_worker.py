"""Private per-channel, fail-closed packet-aware HLS worker. No HTTP listener."""
from __future__ import annotations

import argparse
from contextlib import suppress
import http.client
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

import av
from live_packet_stitch import Stitcher, UnsafeSeam, ts_packets


class InitialSourceUnavailable(Exception):
    """No source media was accepted; a later authorization may try again."""


class Body:
    def __init__(self, response, limit, stopped, on_bytes):
        self.response, self.limit, self.stopped, self.on_bytes = response, limit, stopped, on_bytes
        self.used = 0
        self.failed = False
        self.eof = False
        self.prefix = bytearray()

    def read(self, size):
        if self.stopped.is_set() or self.failed:
            return b''
        try:
            # Bound resident read size, not total session bytes: an upstream
            # can legitimately keep one HTTP response open for hours.
            data = self.response.read(min(size, self.limit, 16 * 1024))
        except (TimeoutError, OSError, http.client.HTTPException):
            # PyAV callbacks must return EOF, not raise a timeout through C code.
            self.failed = True
            return b''
        self.used += len(data)
        if data:
            # Bound diagnostic framing evidence; never retain the whole body.
            self.prefix.extend(data[:max(0, 188 * 3 - len(self.prefix))])
            self.on_bytes()
        else:
            self.eof = True
        return data


class Worker:
    def __init__(self, source: str, directory: Path, *, session_bytes=64 * 1024 * 1024,
                 disk_bytes=64 * 1024 * 1024, source_timeout=3., idle_seconds=180.):
        parts = urlsplit(source)
        if (parts.scheme != 'http' or parts.hostname != '127.0.0.1' or not parts.port
                or parts.username or parts.password or parts.fragment or not parts.path.startswith('/api/stream/')
                or not 188 <= session_bytes <= 64 * 1024 * 1024 or disk_bytes < 188
                or source_timeout <= 0 or idle_seconds <= 0):
            raise ValueError('invalid private ingest configuration')
        self.parts, self.directory = parts, directory
        self.session_bytes, self.disk_bytes = session_bytes, disk_bytes
        self.source_timeout, self.idle_seconds = source_timeout, idle_seconds
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.connection = None
        self.child = None
        self.failure = False
        self.failure_type = None
        self.received_media = False
        self.progress = self.directory / '.source-progress'
        self.last_progress = 0.

    def note_progress(self):
        now = time.monotonic()
        if now - self.last_progress >= .25:
            self.last_progress = now
            self.progress.touch(exist_ok=True)

    def cancel(self, *_):
        self.stop.set()
        with self.lock:
            if self.connection:
                self.connection.close()
            if self.child and self.child.poll() is None:
                self.child.kill()

    def open_source(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.parts.port, timeout=self.source_timeout)
        try:
            target = self.parts.path + ('?' + self.parts.query if self.parts.query else '')
            token = os.environ.get('STREAMVAULT_AUTH_TOKEN')
            headers = {'Accept': 'video/mp2t', 'Accept-Encoding': 'identity'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            connection.request('GET', target, headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                raise InitialSourceUnavailable()
            if (response.getheader('Content-Type', '').split(';')[0].strip().lower()
                    not in ('video/mp2t', 'application/octet-stream')
                    or response.getheader('Content-Encoding') not in (None, 'identity')):
                raise UnsafeSeam('source response rejected')
            length = response.getheader('Content-Length')
            if length is not None and not length.isdecimal():
                raise UnsafeSeam('source length rejected')
            with self.lock:
                self.connection = connection
            return connection, Body(response, self.session_bytes, self.stop, self.note_progress), int(length) if length else None
        except (OSError, http.client.HTTPException):
            connection.close()
            raise InitialSourceUnavailable() from None
        except BaseException:
            connection.close()
            raise

    def open_continuation_source(self):
        # A failed HTTP reopen has supplied no successor media. Keep the same
        # mux/stitch state for bounded transport retries; every eventual body
        # still goes through the unchanged strict A/V overlap proof.
        attempts = 3 if self.received_media else 1
        for attempt in range(attempts):
            if self.stop.is_set():
                raise InitialSourceUnavailable()
            try:
                return self.open_source()
            except InitialSourceUnavailable:
                # A provider can reject immediate reopen while releasing the
                # previous connection. Keep three attempts, but leave one and
                # two seconds for that cooldown; never refresh media liveness.
                if attempt + 1 == attempts or self.stop.wait(float(attempt + 1)):
                    raise

    def monitor(self):
        while not self.stop.wait(.1):
            try:
                # Include FFmpeg's unpublished temporary segment and stale files.
                total = 0
                for item in self.directory.iterdir():
                    try:
                        if item.is_file():
                            total += item.stat().st_size
                    except FileNotFoundError:
                        # FFmpeg atomically renames .tmp and deletes old TS;
                        # the next pass counts the replacement, not a failure.
                        continue
                if total > self.disk_bytes:
                    self.failure = True
                    self.cancel()
                    return
            except OSError:
                self.failure = True
                self.cancel()
                return

    def run(self):
        # Node reserved a private, empty mkdtemp staging directory before spawn.
        if not self.directory.is_dir() or any(self.directory.iterdir()):
            raise UnsafeSeam('staging directory is not empty')
        self.progress.touch(mode=0o600)
        monitor = threading.Thread(target=self.monitor, daemon=True)
        monitor.start()
        # The Node owner retires idle channels. A worker wall-clock deadline
        # would silently terminate an actively viewed channel after minutes.
        # Keep the constructor's legacy idle_seconds argument for local probes,
        # but never use it to terminate a live presentation.
        child = None
        try:
            args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                    # Input is already validated H.264/AAC TS. Bound discovery
                    # so a short first body cannot leave FFmpeg awaiting more
                    # media while the HTTP source only supplies null packets.
                    '-analyzeduration', '1000000', '-probesize', '1048576',
                    '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0',
                    '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '64',
                    '-hls_flags', 'delete_segments+temp_file+independent_segments+omit_endlist',
                    '-hls_segment_filename', str(self.directory / '%d.ts'), str(self.directory / 'index.m3u8')]
            child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with self.lock:
                self.child = child
            stitcher = Stitcher()
            with av.open(child.stdin, 'w', format='mpegts', options={'mpegts_flags': '+resend_headers'}) as mux:
                mapped = None
                # Keep one PyAV mux and one FFmpeg mux for this channel's lifetime.
                while not self.stop.is_set():
                    connection, body, length = self.open_continuation_source()
                    try:
                        with av.open(body, 'r', format='mpegts') as demux:
                            packets = ts_packets(demux)
                            first = next(packets)
                            self.received_media = True
                            if mapped is None:
                                mapped = {stream.type: mux.add_stream_from_template(stream) for stream in demux.streams}
                            from itertools import chain
                            for packet in stitcher.feed(chain((first,), packets)):
                                if self.stop.is_set() or self.failure:
                                    raise UnsafeSeam('worker stopped')
                                native = packet.native
                                native.pts, native.dts = packet.pts, packet.dts
                                native.stream = mapped[packet.kind]
                                mux.mux(native)
                        # Clean EOF can bisect a TS packet. A chunked socket
                        # timeout is NOT clean EOF, but after a substantial
                        # body may be retried only through the same strict A/V
                        # seam proof. Length-delimited truncation is unsafe;
                        # memory and disk are capped separately.
                        if ((length is not None and body.used != length)
                                or (body.failed and (length is not None or body.used < 188 * 100))
                                or self.stop.is_set()):
                            raise UnsafeSeam('source body incomplete or interrupted')
                    except (av.FFmpegError, StopIteration):
                        # Body turns socket errors into EOF for PyAV's C read
                        # callback. Restore their transport meaning only before
                        # any accepted packet; explicit UnsafeSeam validation
                        # failures and all established presentations stay latched.
                        if (not self.received_media and not self.stop.is_set() and not self.failure
                                and all(body.prefix[offset] == 0x47 for offset in range(0, len(body.prefix), 188))
                                and (body.failed or (body.eof and length is not None and body.used != length))):
                            raise InitialSourceUnavailable() from None
                        raise
                    finally:
                        with self.lock:
                            self.connection = None
                        connection.close()
                if self.failure or self.stop.is_set():
                    raise UnsafeSeam('worker stopped')
                for packet in stitcher.finish():
                    native = packet.native
                    native.pts, native.dts = packet.pts, packet.dts
                    native.stream = mapped[packet.kind]
                    mux.mux(native)
            child.stdin.close()
            if child.wait(timeout=10) != 0:
                raise UnsafeSeam('HLS mux failed')
        except BaseException as exc:
            retryable = isinstance(exc, InitialSourceUnavailable) and not self.received_media
            self.failure = True
            self.failure_type = type(exc).__name__
            self.cancel()
            if child:
                with suppress(Exception):
                    child.wait(timeout=5)
                with suppress(Exception):
                    child.stdin.close()
            # A failed seam invalidates ALL cached output. Never expose an old
            # manifest alongside an unproved successor.
            for item in self.directory.iterdir():
                if item.is_file():
                    item.unlink()
            # No packet was ever accepted on an unavailable initial source:
            # a later authorization may start a fresh presentation. All media
            # or seam failures stay latched, with cached segments invalidated.
            (self.directory / ('RETRYABLE' if retryable else 'UNSAFE')).touch()
        finally:
            self.stop.set()
            monitor.join(timeout=2)
        return 2 if self.failure else 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--disk-bytes', type=int, required=True)
    parser.add_argument('--session-bytes', type=int, default=64 * 1024 * 1024)
    parser.add_argument('--source-timeout', type=float, default=3.)
    args = parser.parse_args()
    try:
        worker = Worker(args.source, args.directory, disk_bytes=args.disk_bytes,
                        session_bytes=args.session_bytes, source_timeout=args.source_timeout)
        signal.signal(signal.SIGTERM, worker.cancel)
        signal.signal(signal.SIGINT, worker.cancel)
        return worker.run()
    except BaseException:
        # Never print exception text: HTTP errors may contain credentialed URLs.
        return 2


if __name__ == '__main__':
    sys.exit(main())
