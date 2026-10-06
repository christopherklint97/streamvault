"""A viewed packet worker must outlive long upstream responses and wall time."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from live_packet_worker import Body, InitialSourceUnavailable, Worker
from live_packet_stitch import UnsafeSeam


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


    def test_monitor_ignores_ffmpeg_temp_file_rename_between_listing_and_stat(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            (stage / 'vanishing.ts').write_bytes(b'x')
            worker = Worker('http://127.0.0.1:1/api/stream/channel-a', stage)
            original_stat = Path.stat
            seen = 0
            def renamed(path, *args, **kwargs):
                nonlocal seen
                if path.name == 'vanishing.ts':
                    seen += 1
                    if seen == 2:
                        raise FileNotFoundError('FFmpeg atomically renamed this stage file')
                return original_stat(path, *args, **kwargs)
            with patch.object(Path, 'stat', renamed):
                watcher = threading.Thread(target=worker.monitor, daemon=True)
                watcher.start()
                time.sleep(.35)
                worker.stop.set()
                watcher.join(timeout=2)
            self.assertGreaterEqual(seen, 2)
            self.assertFalse(worker.failure)

class WorkerReopenTests(unittest.TestCase):
    def worker(self, stage):
        worker = Worker('http://127.0.0.1:1/api/stream/channel-a', stage)
        worker.received_media = True
        return worker

    def test_transient_reopen_keeps_the_same_worker_and_returns_the_provable_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = self.worker(Path(tmp))
            child = object()
            worker.child = child
            result = (object(), object(), None)
            with patch.object(worker, 'open_source', side_effect=[InitialSourceUnavailable(), result]) as opened, patch.object(worker.stop, 'wait', return_value=False):
                self.assertIs(worker.open_continuation_source(), result)
            self.assertEqual(opened.call_count, 2)
            self.assertIs(worker.child, child)
            self.assertTrue(worker.received_media)
            self.assertFalse(worker.failure)

    def test_reopen_waits_out_a_three_second_provider_close_cooldown(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = self.worker(Path(tmp))
            result = (object(), object(), None)
            elapsed = 0.
            def unavailable_until_cooldown():
                if elapsed < 3.:
                    raise InitialSourceUnavailable()
                return result
            def cancellable_wait(delay):
                nonlocal elapsed
                elapsed += delay
                return False
            with patch.object(worker, 'open_source', side_effect=unavailable_until_cooldown) as opened, \
                    patch.object(worker.stop, 'wait', side_effect=cancellable_wait) as waited, \
                    patch.object(worker, 'note_progress') as progress:
                self.assertIs(worker.open_continuation_source(), result)
            self.assertEqual(opened.call_count, 3)
            self.assertEqual([call.args[0] for call in waited.call_args_list], [1., 2.])
            progress.assert_not_called()
            self.assertFalse(worker.failure)

    def test_reopen_budget_exhausts_after_three_attempts(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = self.worker(Path(tmp))
            with patch.object(worker, 'open_source', side_effect=InitialSourceUnavailable()) as opened, patch.object(worker.stop, 'wait', return_value=False):
                with self.assertRaises(InitialSourceUnavailable): worker.open_continuation_source()
            self.assertEqual(opened.call_count, 3)

    def test_cold_start_does_not_hot_retry_inside_the_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = Worker('http://127.0.0.1:1/api/stream/channel-a', Path(tmp))
            with patch.object(worker, 'open_source', side_effect=InitialSourceUnavailable()) as opened:
                with self.assertRaises(InitialSourceUnavailable): worker.open_continuation_source()
            self.assertEqual(opened.call_count, 1)

    def test_cancel_and_unsafe_response_do_not_retry(self):
        for cancel in (True, False):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as tmp:
                worker = self.worker(Path(tmp))
                failure = InitialSourceUnavailable() if cancel else UnsafeSeam('source response rejected')
                with patch.object(worker, 'open_source', side_effect=failure) as opened, patch.object(worker.stop, 'wait', return_value=True):
                    with self.assertRaises(type(failure)): worker.open_continuation_source()
                self.assertEqual(opened.call_count, 1)


class ScriptedResponse:
    """Deterministic HTTP read outcomes, consumed by real Body/PyAV code."""
    def __init__(self, data=b'', error=None):
        self.data, self.error = data, error

    def read(self, size):
        if self.data:
            data, self.data = self.data[:size], self.data[size:]
            return data
        if self.error:
            raise self.error
        return b''

    def close(self):
        pass


class WorkerInitialTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = tempfile.TemporaryDirectory()
        root = Path(cls.fixtures.name)
        cls.media = {}
        for codec in ('libx264', 'mpeg2video'):
            fixture = root / f'{codec}.ts'
            subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                            '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3',
                            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3',
                            '-c:v', codec, '-g', '20', '-bf', '0', '-c:a', 'aac',
                            '-f', 'mpegts', str(fixture)], check=True, capture_output=True, timeout=25)
            cls.media[codec] = fixture.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixtures.cleanup()

    def assert_classification(self, response, length, marker, *, received_media=False):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            worker = Worker('http://127.0.0.1:1/api/stream/channel-a', stage)
            worker.received_media = received_media
            body = Body(response, worker.session_bytes, worker.stop, worker.note_progress)
            with patch.object(worker, 'open_source', return_value=(response, body, length)):
                self.assertEqual(worker.run(), 2)
            self.assertEqual({item.name for item in stage.iterdir()}, {marker}, worker.failure_type)
            return worker, body

    def test_default_read_timeout_survives_a_three_and_half_second_media_gap(self):
        data = self.media['libx264']
        class Source(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Type', 'video/mp2t')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                midpoint = len(data) // 2
                try:
                    self.wfile.write(data[:midpoint])
                    self.wfile.flush()
                    time.sleep(3.5)
                    self.wfile.write(data[midpoint:])
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Source)
        serve = threading.Thread(target=server.serve_forever, daemon=True)
        serve.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                worker = Worker(f'http://127.0.0.1:{server.server_port}/api/stream/channel-a', Path(tmp))
                connection, body, length = worker.open_source()
                try:
                    received = bytearray()
                    while chunk := body.read(16 * 1024):
                        received.extend(chunk)
                    self.assertFalse(body.failed)
                    self.assertEqual(bytes(received), data)
                    self.assertEqual(length, len(data))
                    self.assertLess(worker.source_timeout, 15.)
                finally:
                    connection.close()
        finally:
            server.shutdown()
            server.server_close()
            serve.join(timeout=2)

    def test_initial_body_timeout_without_media_is_retryable(self):
        worker, body = self.assert_classification(ScriptedResponse(error=TimeoutError()), None, 'RETRYABLE')
        self.assertTrue(body.failed)
        self.assertFalse(worker.received_media)

    def test_initial_body_http_truncation_without_media_is_retryable(self):
        self.assert_classification(ScriptedResponse(error=http.client.IncompleteRead(b'', 188)), 188, 'RETRYABLE')

    def test_initial_length_delimited_eof_without_media_is_retryable(self):
        self.assert_classification(ScriptedResponse(), 188, 'RETRYABLE')

    def test_initial_transport_timeout_after_only_ts_headers_is_retryable(self):
        self.assert_classification(ScriptedResponse(self.media['libx264'][:188], TimeoutError()), None, 'RETRYABLE')

    def test_initial_truncation_after_only_ts_headers_is_retryable(self):
        self.assert_classification(ScriptedResponse(self.media['libx264'][:188]), len(self.media['libx264']), 'RETRYABLE')

    def test_complete_malformed_body_stays_unsafe(self):
        data = b'not transport-stream media' * 1000
        self.assert_classification(ScriptedResponse(data), len(data), 'UNSAFE')

    def test_malformed_body_with_a_transport_timeout_stays_unsafe(self):
        data = b'not transport-stream media' * 1000
        self.assert_classification(ScriptedResponse(data, TimeoutError()), None, 'UNSAFE')

    def test_incompatible_codec_before_any_accepted_media_stays_unsafe(self):
        data = self.media['mpeg2video']
        worker, _ = self.assert_classification(ScriptedResponse(data), len(data), 'UNSAFE')
        self.assertFalse(worker.received_media)
        self.assertEqual(worker.failure_type, 'UnsafeSeam')

    def test_body_truncation_after_accepted_media_stays_unsafe(self):
        data = self.media['libx264']
        worker, _ = self.assert_classification(ScriptedResponse(data), len(data) + 188, 'UNSAFE')
        self.assertTrue(worker.received_media)

    def test_unavailable_successor_after_accepted_media_stays_unsafe(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            worker = Worker('http://127.0.0.1:1/api/stream/channel-a', stage)
            response = ScriptedResponse(self.media['libx264'], TimeoutError())
            body = Body(response, worker.session_bytes, worker.stop, worker.note_progress)
            with patch.object(worker, 'open_source', side_effect=[
                    (response, body, None), InitialSourceUnavailable(), InitialSourceUnavailable(), InitialSourceUnavailable()]) as source:
                self.assertEqual(worker.run(), 2)
            self.assertTrue(worker.received_media)
            self.assertEqual({item.name for item in stage.iterdir()}, {'UNSAFE'})
            self.assertEqual(source.call_count, 4)

    def test_transport_retry_followed_by_malformed_successor_stays_unsafe(self):
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            worker = Worker('http://127.0.0.1:1/api/stream/channel-a', stage)
            first = ScriptedResponse(self.media['libx264'], TimeoutError())
            first_body = Body(first, worker.session_bytes, worker.stop, worker.note_progress)
            invalid = b'not transport-stream media' * 1000
            successor = ScriptedResponse(invalid)
            successor_body = Body(successor, worker.session_bytes, worker.stop, worker.note_progress)
            with patch.object(worker, 'open_source', side_effect=[
                    (first, first_body, None), InitialSourceUnavailable(),
                    (successor, successor_body, len(invalid))]) as source:
                self.assertEqual(worker.run(), 2)
            self.assertTrue(worker.received_media)
            self.assertEqual(source.call_count, 3)
            self.assertEqual({item.name for item in stage.iterdir()}, {'UNSAFE'})

    def test_initial_timeout_after_an_established_presentation_stays_unsafe(self):
        self.assert_classification(ScriptedResponse(error=TimeoutError()), None, 'UNSAFE', received_media=True)


if __name__ == '__main__':
    unittest.main()
