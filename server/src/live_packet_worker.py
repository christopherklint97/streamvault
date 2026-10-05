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


class Body:
    def __init__(self, response, limit, stopped, on_bytes):
        self.response, self.limit, self.stopped, self.on_bytes = response, limit, stopped, on_bytes
        self.used = 0
        self.failed = False

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
            self.on_bytes()
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
            if (response.status != 200 or response.getheader('Content-Type', '').split(';')[0].strip().lower()
                    not in ('video/mp2t', 'application/octet-stream')
                    or response.getheader('Content-Encoding') not in (None, 'identity')):
                raise UnsafeSeam('source response rejected')
            length = response.getheader('Content-Length')
            if length is not None and not length.isdecimal():
                raise UnsafeSeam('source length rejected')
            with self.lock:
                self.connection = connection
            return connection, Body(response, self.session_bytes, self.stop, self.note_progress), int(length) if length else None
        except BaseException:
            connection.close()
            raise

    def monitor(self):
        while not self.stop.wait(.1):
            try:
                # Include FFmpeg's unpublished temporary segment and stale files.
                total = sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())
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
                    '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0',
                    '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '16',
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
                    connection, body, length = self.open_source()
                    try:
                        with av.open(body, 'r', format='mpegts') as demux:
                            packets = ts_packets(demux)
                            first = next(packets)
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
            (self.directory / 'UNSAFE').touch()
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
