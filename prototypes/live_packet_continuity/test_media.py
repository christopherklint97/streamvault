"""Executable media gates; synthetic fixtures are generated locally, never committed."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import av
sys.path.insert(0, str(Path(__file__).parent))
from stitch import run

SCRATCH = Path('/home/christopherklint/.hermes/cache/scratch')
CAPTURE = SCRATCH / 'live-eof-samples'


def packets(file):
    out = {'video': [], 'audio': []}
    with av.open(str(file), 'r') as src:
        for p in src.demux():
            if p.size and p.stream.type in out:
                out[p.stream.type].append((bytes(p), p.pts, p.dts, p.is_keyframe))
    return out


def decode(file, seconds=None):
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
           '-i', str(file)]
    if seconds:
        cmd += ['-t', str(seconds)]
    cmd += ['-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']
    return subprocess.run(cmd, capture_output=True, timeout=90)


def make_synthetic(folder):
    full = folder / 'full.ts'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                    '-f', 'lavfi', '-i', 'testsrc=size=160x96:rate=25',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50',
                    '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k',
                    '-f', 'mpegts', str(full)], check=True, capture_output=True, timeout=90)
    with av.open(str(full)) as src:
        video = [p for p in src.demux(video=0) if p.size]
    start, end = video[150].dts, video[210].dts
    for side in ('first', 'second'):
        with av.open(str(full)) as src, av.open(str(folder / (side + '.ts')), 'w', format='mpegts') as dst:
            streams = {s.index: dst.add_stream_from_template(s) for s in src.streams}
            vi = 0
            for p in src.demux():
                if not p.size or p.pts is None or p.dts is None:
                    continue
                if p.stream.type == 'video':
                    keep = vi < 210 if side == 'first' else vi >= 150
                    vi += 1
                else:
                    keep = p.dts < end if side == 'first' else p.dts >= start
                if not keep:
                    continue
                if side == 'second':
                    p.pts -= 270000
                    p.dts -= 270000
                p.stream = streams[p.stream.index]
                dst.mux(p)
    return folder / 'first.ts', folder / 'second.ts'


class MediaGates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='packet-continuity-', dir=SCRATCH)
        cls.folder = Path(cls.tmp.name)
        cls.first, cls.second = make_synthetic(cls.folder)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_input_session_cap_rejects_before_opening_output(self):
        out = self.folder / 'too-many.ts'
        with self.assertRaises(ValueError):
            run([self.first] * 9, out)
        self.assertFalse(out.exists())

    def test_input_byte_cap_rejects_before_opening_output(self):
        large = self.folder / 'oversized.ts'
        with large.open('wb') as f:
            f.truncate(65 * 1024 * 1024)
        out = self.folder / 'oversized-result.ts'
        with self.assertRaises(ValueError):
            run([self.first, large], out)
        self.assertFalse(out.exists())

    def test_failed_seam_does_not_leave_playable_playlist(self):
        altered = self.folder / 'audio-shifted.ts'
        with av.open(str(self.second)) as src, av.open(str(altered), 'w', format='mpegts') as dst:
            mapped = {s.index: dst.add_stream_from_template(s) for s in src.streams}
            for packet in src.demux():
                if not packet.size:
                    continue
                if packet.stream.type == 'audio':
                    packet.pts += 1920
                    packet.dts += 1920
                packet.stream = mapped[packet.stream.index]
                dst.mux(packet)
        directory = self.folder / 'unsafe-hls'
        from stitch import UnsafeSeam
        with self.assertRaises(UnsafeSeam):
            run([self.first, altered], directory, hls=True)
        self.assertFalse((directory / 'index.m3u8').exists())
        self.assertTrue((directory / 'UNSAFE').exists())

    def test_synthetic_copy_keeps_original_order_and_non_idr_continuation(self):
        out = self.folder / 'synthetic-continuous.ts'
        info = run([self.first, self.second], out)
        original = packets(self.folder / 'full.ts')
        result = packets(out)
        for kind in ('video', 'audio'):
            self.assertEqual([x[0] for x in result[kind]], [x[0] for x in original[kind]])
            self.assertEqual([x[1:3] for x in result[kind]], [x[1:3] for x in original[kind]])
        self.assertEqual(info['packets']['video'], len(original['video']))
        self.assertFalse(result['video'][210][3])  # continuation is not a fresh IDR
        decoded = decode(out)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors='replace')[:500])
        self.assertEqual(decoded.stderr, b'')

    def test_synthetic_hls_retains_packet_chain_and_decodes(self):
        directory = self.folder / 'synthetic-hls'
        info = run([self.first, self.second], directory, hls=True)
        playlist = (directory / 'index.m3u8').read_text()
        self.assertIn('#EXT-X-INDEPENDENT-SEGMENTS', playlist)
        self.assertNotIn('#EXT-X-DISCONTINUITY', playlist)
        self.assertLessEqual(len(list(directory.glob('*.ts'))), 14)
        out = packets(directory / 'index.m3u8')
        baseline = packets(self.folder / 'full.ts')
        for kind in ('video', 'audio'):
            self.assertEqual([x[0] for x in out[kind]], [x[0] for x in baseline[kind]])
        decoded = decode(directory / 'index.m3u8')
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors='replace')[:500])
        self.assertEqual(decoded.stderr, b'')

    @unittest.skipUnless((CAPTURE / 'first.ts').is_file() and (CAPTURE / 'second.ts').is_file(), 'captured seam unavailable')
    def test_captured_hls_retains_non_idr_seam_and_strictly_decodes_through_it(self):
        directory = self.folder / 'captured-hls'
        run([CAPTURE / 'first.ts', CAPTURE / 'second.ts'], directory, hls=True)
        manifest = (directory / 'index.m3u8').read_text()
        self.assertIn('#EXT-X-INDEPENDENT-SEGMENTS', manifest)
        self.assertNotIn('#EXT-X-DISCONTINUITY', manifest)
        self.assertLessEqual(len(list(directory.glob('*.ts'))), 14)
        segments = sorted(directory.glob('*.ts'), key=lambda p: int(p.stem))
        self.assertTrue(all(packets(segment)['video'][0][3] for segment in segments))
        first_segment = decode(segments[0])
        self.assertEqual(first_segment.returncode, 0, first_segment.stderr.decode(errors='replace')[:500])
        self.assertEqual(first_segment.stderr, b'')
        hls = packets(directory / 'index.m3u8')
        baseline = packets(self.folder / 'captured.ts') if (self.folder / 'captured.ts').exists() else None
        if baseline is None:
            reference = self.folder / 'captured-reference.ts'
            run([CAPTURE / 'first.ts', CAPTURE / 'second.ts'], reference)
            baseline = packets(reference)
        for kind in ('video', 'audio'):
            seq = [x[0] for x in hls[kind]]
            reference = [x[0] for x in baseline[kind]]
            first = reference.index(seq[0])
            self.assertEqual(seq, reference[first:first+len(seq)])
            offsets = {a[1]-b[1] for a,b in zip(hls[kind], baseline[kind][first:first+len(seq)])}
            self.assertEqual(len(offsets), 1)
        unique = packets(CAPTURE / 'second.ts')['video'][415][0]
        self.assertFalse(packets(CAPTURE / 'second.ts')['video'][415][3])
        self.assertIn(unique, [x[0] for x in hls['video']])
        decoded = decode(directory / 'index.m3u8', seconds=15)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors='replace')[:500])
        self.assertEqual(decoded.stderr, b'')

    @unittest.skipUnless((CAPTURE / 'first.ts').is_file() and (CAPTURE / 'second.ts').is_file(), 'captured seam unavailable')
    def test_captured_seam_exact_inventory_continuous_timestamps_and_strict_decode(self):
        first, second = packets(CAPTURE / 'first.ts'), packets(CAPTURE / 'second.ts')
        out_path = self.folder / 'captured.ts'
        info = run([CAPTURE / 'first.ts', CAPTURE / 'second.ts'], out_path)
        actual = packets(out_path)
        cuts = {'video': (2515, 415, 3003), 'audio': (4049, 762, 1920)}
        for kind, (cut, skip, step) in cuts.items():
            expected = first[kind][:cut] + second[kind][skip:]
            self.assertEqual(len(actual[kind]), len(expected))
            self.assertEqual([x[0] for x in actual[kind]], [x[0] for x in expected])
            self.assertEqual(info['packets'][kind], len(expected))
            self.assertEqual([x[2] for x in actual[kind][cut-1:cut+2]],
                             [expected[cut-1][2], expected[cut][2]+6307200, expected[cut+1][2]+6307200])
            self.assertEqual({b[2]-a[2] for a,b in zip(actual[kind], actual[kind][1:])}, {step})
            self.assertEqual({b-a for a,b in zip(sorted(x[1] for x in actual[kind]),
                                               sorted(x[1] for x in actual[kind])[1:])}, {step})
        self.assertFalse(second['video'][415][3])
        self.assertEqual(info['duplicates'], {'video': 416, 'audio': 762})  # includes withheld replacement
        result = decode(out_path, seconds=94)  # second capture ends mid-video packet; do not decode that tail
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors='replace')[:500])
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
