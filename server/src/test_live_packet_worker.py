"""A viewed packet worker must outlive long upstream responses and wall time."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

from live_packet_worker import Worker


class WorkerLifetimeTests(unittest.TestCase):
    def probe(self, *, idle_seconds=180, session_bytes=64 * 1024 * 1024):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = root / 'source.ts'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
                            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-bf', '0',
                            '-c:a', 'aac', '-f', 'mpegts', str(fixture)],
                           check=True, capture_output=True, timeout=25)
            data = fixture.read_bytes()
            class Source(BaseHTTPRequestHandler):
                requests = 0
                def log_message(self, *_):
                    pass
                def do_GET(self):
                    type(self).requests += 1
                    self.send_response(200)
                    self.send_header('Content-Type', 'video/mp2t')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    if type(self).requests == 1 and idle_seconds < 2:
                        time.sleep(1.2)
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), Source)
            serve = threading.Thread(target=server.serve_forever, daemon=True)
            serve.start()
            stage = root / 'stage'
            stage.mkdir()
            worker = Worker(f'http://127.0.0.1:{server.server_port}/api/stream/channel-a',
                            stage, idle_seconds=idle_seconds, session_bytes=session_bytes)
            task = threading.Thread(target=worker.run, daemon=True)
            task.start()
            try:
                deadline = time.monotonic() + 8
                while Source.requests < 2 and time.monotonic() < deadline:
                    time.sleep(.05)
                self.assertGreaterEqual(Source.requests, 2, f'worker failure={worker.failure_type}')
            finally:
                worker.cancel()
                task.join(timeout=5)
                server.shutdown()
                server.server_close()
                serve.join(timeout=2)
            self.assertFalse(task.is_alive())

    def test_worker_does_not_stop_after_arbitrary_run_duration(self):
        self.probe(idle_seconds=.8)

    def test_long_length_delimited_response_does_not_exhaust_a_cumulative_byte_cap(self):
        self.probe(session_bytes=188 * 100)


if __name__ == '__main__':
    unittest.main()
