"""Loopback-only shared live HTTP demo; not a StreamVault route or deployable server."""
from __future__ import annotations

import argparse
from contextlib import suppress
import hmac
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qs, urlsplit

import av
from stitch import Stitcher, UnsafeSeam, ts_packets


class BoundedBody:
    def __init__(self, response, limit, stopped):
        self.response, self.limit, self.stopped = response, limit, stopped
        self.used = 0
        self.over_limit = False
        self.read_failed = False

    def read(self, size):
        if self.stopped.is_set() or self.over_limit or self.read_failed:
            return b''
        try:
            data = self.response.read(min(size, self.limit - self.used + 1))
        except (TimeoutError, OSError, http.client.HTTPException):
            self.read_failed = True
            return b''
        self.used += len(data)
        if self.used > self.limit:
            self.over_limit = True
            return b''
        return data


class LiveService:
    """One admitted H.264/AAC channel, one demuxer and one persistent HLS child."""
    def __init__(self, source_url: str, directory: Path, *, secret: bytes, api_key: bytes,
                 max_sessions: int = 8, session_bytes: int = 64 * 1024 * 1024,
                 disk_bytes: int = 64 * 1024 * 1024, source_timeout: float = 3,
                 max_run_seconds: float = 180, channel: str = 'demo'):
        parts = urlsplit(source_url)
        if (parts.scheme != 'http' or not parts.hostname or parts.username or parts.password
                or parts.fragment or not secret or not api_key or max_sessions < 1
                or session_bytes < 188 or disk_bytes < 188 or source_timeout <= 0
                or max_run_seconds <= 0 or not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}', channel)):
            raise ValueError('invalid local demo configuration')
        self.source_url, self.directory = source_url, Path(directory)
        self.secret, self.api_key, self.channel = secret, api_key, channel
        self.max_sessions, self.session_bytes = max_sessions, session_bytes
        self.disk_bytes, self.source_timeout, self.max_run_seconds = disk_bytes, source_timeout, max_run_seconds
        self.stopped, self.done = threading.Event(), threading.Event()
        self.lock = threading.RLock()
        self.error = None
        self.stage = 'initial'
        self.worker = None
        self.source_connection = None
        self.child = None
        self.server = None
        self.http_thread = None
        self.monitor = None
        self.generation = secrets.token_hex(8)

    @property
    def port(self):
        return self.server.server_port

    def _signature(self, path, expiry):
        return hmac.new(self.secret, f'{self.generation}:{path}:{expiry}'.encode(), hashlib.sha256).hexdigest()

    def _signed(self, path, expiry):
        return f'{path}?expires={expiry}&sig={self._signature(path, expiry)}'

    def _authorized(self, path, query):
        try:
            fields = parse_qs(query, strict_parsing=True)
            if set(fields) != {'expires', 'sig'}:
                return False
            expiry = int(fields['expires'][0])
            return int(time.time()) <= expiry <= int(time.time()) + 3600 and hmac.compare_digest(
                fields['sig'][0], self._signature(path, expiry))
        except (ValueError, IndexError, KeyError):
            return False

    def start(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if any(self.directory.iterdir()):
            raise ValueError('demo directory must be empty and private')
        parent = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                request = urlsplit(self.path)
                prefix = f'/api/live/{parent.channel}/'
                if not request.path.startswith(prefix):
                    return self._send(404)
                name = request.path[len(prefix):]
                if name == 'authorize':
                    if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), b'Bearer ' + parent.api_key):
                        return self._send(403)
                    path = prefix + 'index.m3u8'
                    body = json.dumps({'playlistUrl': parent._signed(path, int(time.time()) + 900)}).encode()
                    return self._send(200, body, 'application/json')
                if not parent._authorized(request.path, request.query):
                    return self._send(403)
                if name == 'index.m3u8':
                    with parent.lock:
                        if parent.error or parent.stopped.is_set():
                            return self._send(503)
                        try:
                            text = (parent.directory / name).read_text()
                        except FileNotFoundError:
                            return self._send(503)
                        expiry = int(parse_qs(request.query)['expires'][0])
                        text = re.sub(r'(?m)^(\d+\.ts)$',
                                      lambda m: parent._signed(f'{prefix}segment/{m.group(1)}', expiry).removeprefix(prefix), text)
                        return self._send(200, text.encode(), 'application/vnd.apple.mpegurl')
                match = re.fullmatch(r'segment/(\d+)\.ts', name)
                if not match:
                    return self._send(404)
                with parent.lock:
                    if parent.error or parent.stopped.is_set():
                        return self._send(503)
                    target = parent.directory / (match.group(1) + '.ts')
                    try:
                        content = target.read_bytes()
                    except FileNotFoundError:
                        return self._send(404)
                    return self._send(200, content, 'video/mp2t')
            def _send(self, status, body=b'', content_type='text/plain'):
                self.send_response(status)
                self.send_header('Content-Type', content_type)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                with suppress(BrokenPipeError, ConnectionResetError):
                    self.wfile.write(body)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker = threading.Thread(target=self._ingest, daemon=True)
        self.monitor = threading.Thread(target=self._monitor, daemon=True)
        self.http_thread.start()
        self.monitor.start()
        self.worker.start()

    def _open_source(self):
        parts = urlsplit(self.source_url)
        conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=self.source_timeout)
        try:
            conn.request('GET', (parts.path or '/') + ('?' + parts.query if parts.query else ''),
                         headers={'Accept': 'video/mp2t', 'Accept-Encoding': 'identity'})
            self.stage = 'source-request'
            response = conn.getresponse()
            self.stage = 'source-headers'
            if response.status != 200 or response.getheader('Content-Type', '').split(';')[0].lower() not in ('video/mp2t', 'application/octet-stream'):
                raise UnsafeSeam('source response is not TS')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > self.session_bytes):
                raise UnsafeSeam('source length invalid or over cap')
            if response.getheader('Content-Encoding') not in (None, 'identity'):
                raise UnsafeSeam('encoded source not supported')
            with self.lock:
                self.source_connection = conn
            return conn, BoundedBody(response, self.session_bytes, self.stopped)
        except BaseException:
            conn.close()
            raise

    def _monitor(self):
        while not self.done.wait(.1) and not self.stopped.is_set():
            with self.lock:
                # Includes FFmpeg's unpublished .tmp segment, not just playlist entries.
                usage = sum(p.stat().st_size for p in self.directory.iterdir() if p.is_file())
                if usage > self.disk_bytes:
                    self.error = 'HLS disk cap exceeded'
                    self.stopped.set()
                    if self.source_connection:
                        self.source_connection.close()
                    if self.child:
                        self.child.kill()
                    break

    def _ingest(self):
        stitcher = Stitcher()
        began = time.monotonic()
        child = None
        try:
            args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin',
                    '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0',
                    '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '12',
                    '-hls_flags', 'delete_segments+temp_file+independent_segments',
                    '-hls_segment_filename', str(self.directory / '%d.ts'),
                    str(self.directory / 'index.m3u8')]
            child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            with self.lock:
                self.child = child
            with av.open(child.stdin, 'w', format='mpegts', options={'mpegts_flags': '+resend_headers'}) as mux:
                mapped = None
                for _ in range(self.max_sessions):
                    if self.stopped.is_set() or time.monotonic() - began > self.max_run_seconds:
                        raise UnsafeSeam('cancelled or run deadline exceeded')
                    conn, body = self._open_source()
                    self.stage = 'source-open'
                    try:
                        with av.open(body, 'r', format='mpegts') as demux:
                            self.stage = 'demux-open'
                            packets = ts_packets(demux)
                            if mapped is None:
                                # Validate before publishing the first packet.
                                first = next(packets)
                                mapped = {s.type: mux.add_stream_from_template(s) for s in demux.streams}
                                from itertools import chain
                                packets = chain((first,), packets)
                            for packet in stitcher.feed(packets):
                                if self.stopped.is_set() or time.monotonic() - began > self.max_run_seconds:
                                    raise UnsafeSeam('cancelled or run deadline exceeded')
                                native = packet.native
                                native.pts, native.dts = packet.pts, packet.dts
                                native.stream = mapped[packet.kind]
                                mux.mux(native)
                        length = body.response.getheader('Content-Length')
                        if length is not None and body.used != int(length):
                            raise UnsafeSeam('declared source length not consumed')
                        if body.read_failed and (length is not None
                                                 or body.used < 188 * 100):
                            raise UnsafeSeam('length-delimited truncation or insufficient stalled TS')
                        if body.over_limit:
                            raise UnsafeSeam('source session byte cap exceeded')
                        if self.stopped.is_set():
                            raise UnsafeSeam('cancelled')
                    finally:
                        with self.lock:
                            self.source_connection = None
                        conn.close()
                for packet in stitcher.finish():
                    native = packet.native
                    native.pts, native.dts = packet.pts, packet.dts
                    native.stream = mapped[packet.kind]
                    mux.mux(native)
            child.stdin.close()
            if child.wait(timeout=10):
                raise UnsafeSeam('HLS child failed')
        except BaseException as exc:
            # Deliberately no exception text: HTTP/FFmpeg errors can contain source secrets.
            with self.lock:
                self.error = self.error or type(exc).__name__
                if child and child.poll() is None:
                    child.kill()
                if child:
                    with suppress(Exception):
                        child.wait(timeout=5)
                    with suppress(Exception):
                        child.stdin.close()
                self._clear()
        finally:
            with self.lock:
                self.child = None
                self.worker = None
            self.done.set()

    def _clear(self):
        for file in self.directory.iterdir():
            if file.is_file():
                file.unlink()

    def close(self):
        self.stopped.set()
        with self.lock:
            if self.source_connection:
                self.source_connection.close()
            if self.child and self.child.poll() is None:
                self.child.kill()
        worker = self.worker
        if worker:
            worker.join(timeout=self.source_timeout + 10)
            if worker.is_alive():
                raise RuntimeError('ingest failed to stop')
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.http_thread.join(timeout=3)
            self.server = None
        if self.monitor:
            self.monitor.join(timeout=3)
        with self.lock:
            self._clear()


def main():
    parser = argparse.ArgumentParser(description='Private loopback HLS demonstration only')
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--channel', default='demo')
    args = parser.parse_args()
    import os
    source = os.environ.get('LIVE_DEMO_SOURCE_URL')
    key = os.environ.get('LIVE_DEMO_API_KEY')
    if not source or not key:
        parser.error('LIVE_DEMO_SOURCE_URL and LIVE_DEMO_API_KEY must be set')
    service = LiveService(source, args.directory, secret=secrets.token_bytes(32), api_key=key.encode(), channel=args.channel)
    try:
        service.start()
        print(f'Local demo listening on 127.0.0.1:{service.port}; channel={args.channel}', flush=True)
        service.done.wait()
        print('Ingest stopped: ' + ('unsafe' if service.error else 'session cap reached') +
              '; serving retained finite HLS until Ctrl-C', flush=True)
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        service.close()

if __name__ == '__main__':
    main()
