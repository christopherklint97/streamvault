"""Dual-stream terminal holdback: a demux EOF can truncate AAC too."""
import unittest
from dataclasses import replace
from live_packet_stitch import Packet, Stitcher, UnsafeSeam

def packet(kind, i, shift=0):
    step=3003 if kind=='video' else 1920
    return Packet(kind,i*step-shift,i*step-shift,f'{kind}:{i}'.encode(),kind=='video' and i%25==0)

def session(v0,v1,a0,a1,shift=0):
    return sorted([*(packet('video',i,shift) for i in range(v0,v1)),*(packet('audio',i,shift) for i in range(a0,a1))],key=lambda p:(p.dts,p.kind))

class TerminalAudioTests(unittest.TestCase):
    def test_partial_terminal_aac_is_not_published_and_is_replaced_once(self):
        first=session(0,40,0,64)
        first=[replace(p,data=b'audio:') if p.kind=='audio' and p.dts==63*1920 else p for p in first]
        s=Stitcher(min_run=4,history_packets=128)
        emitted=list(s.feed(first))
        self.assertNotIn(b'audio:',[p.data for p in emitted])
        output=emitted+list(s.feed(session(30,60,47,94,30030)))+list(s.finish())
        self.assertEqual([p.data for p in output if p.kind=='audio'],[packet('audio',i).data for i in range(94)])
        self.assertEqual([p.data for p in output if p.kind=='video'],[packet('video',i).data for i in range(60)])

    def test_unrelated_terminal_audio_replacement_fails_before_new_output(self):
        s=Stitcher(min_run=4,history_packets=128)
        list(s.feed(session(0,40,0,64)))
        second=session(30,60,47,94,30030)
        second=[replace(p,data=b'unrelated') if p.kind=='audio' and p.dts==63*1920-30030 else p for p in second]
        published=[]
        with self.assertRaises(UnsafeSeam):
            for p in s.feed(second):published.append(p)
        self.assertEqual(published,[])

    def test_simultaneous_partial_audio_and_video_are_replaced_once(self):
        first=session(0,40,0,64)
        first=[replace(p,data=p.data[:6]) if (p.kind=='audio' and p.dts==63*1920) or (p.kind=='video' and p.dts==39*3003) else p for p in first]
        s=Stitcher(min_run=4,history_packets=128)
        emitted=list(s.feed(first))
        self.assertNotIn(b'audio:',[p.data for p in emitted])
        self.assertNotIn(b'video:',[p.data for p in emitted])
        output=emitted+list(s.feed(session(30,60,47,94,30030)))+list(s.finish())
        for kind,limit in (('audio',94),('video',60)):
            self.assertEqual([p.data for p in output if p.kind==kind],[packet(kind,i).data for i in range(limit)])

    def test_missing_or_changed_held_audio_fails_before_new_output(self):
        for mutation in ('missing','pts','flags'):
            with self.subTest(mutation=mutation):
                s=Stitcher(min_run=4,history_packets=128)
                list(s.feed(session(0,40,0,64)))
                second=session(30,60,47,94,30030)
                target=next(p for p in second if p.kind=='audio' and p.dts==63*1920-30030)
                if mutation=='missing':
                    second.remove(target)
                else:
                    changed = replace(target,pts=target.pts+1) if mutation=='pts' else replace(target,keyframe=not target.keyframe)
                    second=[changed if p is target else p for p in second]
                published=[]
                with self.assertRaises(UnsafeSeam):
                    for p in s.feed(second):published.append(p)
                self.assertEqual(published,[])

    def test_successive_replays_keep_every_audio_packet_once(self):
        s=Stitcher(min_run=4,history_packets=128)
        output=[*s.feed(session(0,40,0,64)),*s.feed(session(30,60,47,94,30030)),*s.feed(session(50,75,78,118,90090)),*s.finish()]
        self.assertEqual([p.data for p in output if p.kind=='audio'],[packet('audio',i).data for i in range(118)])
        self.assertEqual([p.data for p in output if p.kind=='video'],[packet('video',i).data for i in range(75)])
        for kind in ('audio','video'):
            dts=[p.dts for p in output if p.kind==kind]
            self.assertTrue(all(b>a for a,b in zip(dts,dts[1:])))

if __name__=='__main__':unittest.main()
