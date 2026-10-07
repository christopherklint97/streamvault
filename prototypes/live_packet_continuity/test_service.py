"""Local HTTP end-to-end contract; private captured media never enters logs."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).parent))
from service import LiveService
from test_media import CAPTURE, packets, decode, SCRATCH


class Source(BaseHTTPRequestHandler):
    requests = 0
    mode = 'normal'
    first = None
    second = None
    def log_message(self, *_):
        pass
    def do_GET(self):
        type(self).requests += 1
        number = type(self).requests
        if number == 1:
            data = self.first
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp2t')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            try:
                for i in range(0, len(data), 16384):
                    part = data[i:i + 16384]
                    self.wfile.write(('%x\r\n' % len(part)).encode() + part + b'\r\n')
                if self.mode == 'stall':
                    time.sleep(3)  # The first complete TS body never sends the chunk terminator.
                    return
                self.wfile.write(b'0\r\n\r\n')
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            data = self.second
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp2t')
            self.send_header('Content-Length', str(len(data) + (1880 if self.mode == 'truncated_length' else 0)))
            self.end_headers()
            self.wfile.write(data)


def get(url, headers=None):
    parsed = urlsplit(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=8)
    conn.request('GET', parsed.path + ('?' + parsed.query if parsed.query else ''), headers=headers or {})
    response = conn.getresponse()
    body = response.read()
    status = response.status
    conn.close()
    return status, body


@unittest.skipUnless((CAPTURE / 'first.ts').is_file() and (CAPTURE / 'second.ts').is_file(), 'captured fixture unavailable')
class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        Source.first = (CAPTURE / 'first.ts').read_bytes()
        Source.second = (CAPTURE / 'second.ts').read_bytes()

    @classmethod
    def tearDownClass(cls):
        Source.first = Source.second = None

    def setUp(self):
        Source.requests = 0
        Source.mode = 'normal'
        self.source = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        self.source_thread = threading.Thread(target=self.source.serve_forever, daemon=True)
        self.source_thread.start()
        self.tmp = tempfile.TemporaryDirectory(dir=SCRATCH, prefix='shared-live-')
        self.service = LiveService('http://127.0.0.1:%d/source' % self.source.server_port,
                                   Path(self.tmp.name), secret=b'unit-test-secret', api_key=b'local-api-key', max_sessions=2)
        self.service.start()
        self.base = 'http://127.0.0.1:%d' % self.service.port

    def tearDown(self):
        self.service.close()
        self.source.shutdown()
        self.source.server_close()
        self.source_thread.join(timeout=3)
        self.tmp.cleanup()

    def test_chunked_eof_then_length_eof_signed_hls_and_non_idr_continuation(self):
        self.assertEqual(get(self.base + '/api/live/demo/authorize')[0], 403)
        status, data = get(self.base + '/api/live/demo/authorize', {'Authorization': 'Bearer local-api-key'})
        self.assertEqual(status, 200)
        path = json.loads(data)['playlistUrl']
        self.assertEqual(get(self.base + '/api/live/demo/index.m3u8')[0], 403)
        self.assertTrue(self.service.done.wait(30))
        self.assertIsNone(self.service.error, f'source requests={Source.requests} stage={self.service.stage}')
        self.assertEqual(Source.requests, 2)
        status, playlist = get(self.base + path)
        self.assertEqual(status, 200)
        self.assertNotIn(b'#EXT-X-DISCONTINUITY', playlist)
        segments = [line.decode() for line in playlist.splitlines() if line.endswith(b'.ts') or b'.ts?' in line]
        self.assertTrue(segments)
        self.assertEqual(get(self.base + '/api/live/demo/segment/0.ts')[0], 403)
        self.assertEqual(get(self.base + '/api/live/demo/segment/../index.m3u8')[0], 403)
        for segment in segments:
            self.assertEqual(get(self.base + '/api/live/demo/' + segment)[0], 200)
        manifest = Path(self.tmp.name) / 'index.m3u8'
        self.assertEqual(decode(manifest, seconds=15).returncode, 0)
        unique = packets(CAPTURE / 'second.ts')['video'][415][0]
        self.assertIn(unique, [p[0] for p in packets(manifest)['video']])

    def test_stalled_chunked_body_reopens_and_verifies_seam(self):
        self.service.close()
        Source.requests = 0
        Source.mode = 'stall'
        self.service = LiveService('http://127.0.0.1:%d/source' % self.source.server_port,
                                   Path(self.tmp.name), secret=b'unit-test-secret', api_key=b'local-api-key',
                                   max_sessions=2, source_timeout=1)
        self.service.start()
        self.assertTrue(self.service.done.wait(30))
        self.assertIsNone(self.service.error, f'source requests={Source.requests} stage={self.service.stage}')
        self.assertEqual(Source.requests, 2)
        self.assertTrue((Path(self.tmp.name) / 'index.m3u8').is_file())

    def test_declared_length_truncation_clears_manifest(self):
        self.service.close()
        Source.requests = 0
        Source.mode = 'truncated_length'
        self.service = LiveService('http://127.0.0.1:%d/source' % self.source.server_port,
                                   Path(self.tmp.name), secret=b'unit-test-secret', api_key=b'local-api-key', max_sessions=2)
        self.service.start()
        self.assertTrue(self.service.done.wait(30))
        self.assertIsNotNone(self.service.error)
        self.assertFalse((Path(self.tmp.name) / 'index.m3u8').exists())

    def test_disk_cap_aborts_and_removes_signed_media(self):
        self.service.disk_bytes = 188
        self.assertTrue(self.service.done.wait(30))
        self.assertIsNotNone(self.service.error)
        self.assertFalse((Path(self.tmp.name) / 'index.m3u8').exists())
        self.assertIsNone(self.service.worker)

    def test_bad_ticket_and_cancel_release_worker(self):
        self.assertEqual(get(self.base + '/api/live/demo/authorize')[0], 403)
        status, data = get(self.base + '/api/live/demo/authorize', {'Authorization': 'Bearer local-api-key'})
        self.assertEqual(status, 200)
        playlist = json.loads(data)['playlistUrl']
        self.assertEqual(get(self.base + playlist + 'x')[0], 403)
        self.service.close()
        self.assertTrue(self.service.done.is_set())
        self.assertIsNone(self.service.worker)
        self.assertFalse((Path(self.tmp.name) / 'index.m3u8').exists())


if __name__ == '__main__':
    unittest.main()
