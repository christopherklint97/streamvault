"""Packet-continuity contract; run with python3 -m unittest discover -s prototypes/live_packet_continuity -v."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from stitch import Packet, Stitcher, UnsafeSeam


def p(kind, i, offset=0, payload=None):
    step = 3003 if kind == 'video' else 1920
    return Packet(kind, (i * step) - offset, (i * step) - offset,
                  (payload or f'{kind}:{i}').encode(), kind == 'video' and i % 25 == 0)


def interleave(video, audio):
    return sorted([*video, *audio], key=lambda x: (x.dts, x.kind))


class StitchTests(unittest.TestCase):
    def setUp(self):
        self.s = Stitcher(min_run=4, history_packets=128, max_probe_bytes=20000)
        self.first = interleave([p('video', i) for i in range(40)], [p('audio', i) for i in range(64)])

    def test_replay_drops_only_correlated_dual_stream_prefix_and_keeps_non_idr(self):
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        output = list(self.s.feed(iter(self.first))) + list(self.s.feed(iter(second))) + list(self.s.finish())
        videos = [x.data for x in output if x.kind == 'video']
        audios = [x.data for x in output if x.kind == 'audio']
        self.assertEqual(videos, [p('video', i).data for i in range(60)])
        self.assertEqual(audios, [p('audio', i).data for i in range(94)])
        self.assertEqual([x.dts for x in output if x.kind == 'video'], [i * 3003 for i in range(60)])
        self.assertFalse(next(x.keyframe for x in output if x.kind == 'video' and x.dts == 40*3003))
        self.assertEqual(self.s.duplicates, {'video': 10, 'audio': 17})

    def test_short_match_not_authority_to_drop_unique_picture(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        second[0] = Packet(second[0].kind, second[0].pts, second[0].dts, b'altered', second[0].keyframe)
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_audio_offset_conflict_rejects_before_any_second_session_output(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 31950) for i in range(47, 94)])
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_unrelated_same_timestamp_replacement_rejects_without_dropping_picture(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        target = next(i for i, packet in enumerate(second) if packet.kind == 'video' and packet.data == b'video:39')
        second[target] = Packet('video', second[target].pts, second[target].dts, b'not-the-same', False)
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_missing_internal_duplicate_rejects_instead_of_skipping(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60) if i != 35],
                            [p('audio', i, 30030) for i in range(47, 94)])
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_corrupt_terminal_video_prefix_is_replaced_only_by_matching_complete_packet(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        # The first body's final video packet is only a prefix of the replay replacement.
        # It has not yet been emitted, so there is no decoder-visible corruption.
        self.s.pending_video = p('video', 39, payload='video:')
        output = list(self.s.feed(iter(second))) + list(self.s.finish())
        self.assertEqual([x.data for x in output if x.kind == 'video'][0], b'video:39')

    def test_ambiguous_repetitive_prefix_refuses_to_guess(self):
        first = interleave([p('video', i, payload='static') for i in range(40)],
                           [p('audio', i, payload='silent') for i in range(64)])
        list(self.s.feed(iter(first)))
        replay = interleave([p('video', i, 30030, 'static') for i in range(30, 60)],
                            [p('audio', i, 30030, 'silent') for i in range(47, 94)])
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(replay)))

    def test_bounded_probe_rejects_long_unmatched_input(self):
        list(self.s.feed(iter(self.first)))
        self.s.max_probe_bytes = 24
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(interleave([p('video', i) for i in range(100, 110)],
                                              [p('audio', i) for i in range(100, 120)]))))

    def test_post_proof_timestamp_regression_fails_instead_of_publishing_repeat(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        second += [p('video', 30, 30030)]  # verified run is over; this is now a regression
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_post_proof_large_gap_fails_closed(self):
        list(self.s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        second += [p('audio', 250, 30030)]
        with self.assertRaises(UnsafeSeam):
            list(self.s.feed(iter(second)))

    def test_tiny_history_refuses_overlap_outside_window(self):
        s = Stitcher(min_run=4, history_packets=8, max_probe_bytes=20000)
        list(s.feed(iter(self.first)))
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        with self.assertRaises(UnsafeSeam):
            list(s.feed(iter(second)))

    def test_no_third_generation_raw_replay_after_prior_success(self):
        second = interleave([p('video', i, 30030) for i in range(30, 60)],
                            [p('audio', i, 30030) for i in range(47, 94)])
        third = interleave([p('video', i, 90090) for i in range(50, 75)],
                           [p('audio', i, 90090) for i in range(78, 118)])
        output = [*self.s.feed(iter(self.first)), *self.s.feed(iter(second)),
                  *self.s.feed(iter(third)), *self.s.finish()]
        self.assertEqual([x.data for x in output if x.kind == 'video'], [p('video', i).data for i in range(75)])
        self.assertEqual([x.data for x in output if x.kind == 'audio'], [p('audio', i).data for i in range(118)])


if __name__ == '__main__':
    unittest.main()
