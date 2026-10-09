#!/usr/bin/python3
"""Fail-closed native runtime gate. Run as the image's default non-root user."""
import ctypes
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

EXPECTED = {'libavcodec': 63, 'libavformat': 63, 'libavutil': 61,
            'libavfilter': 12, 'libswscale': 10, 'libswresample': 7}
COMSKIP_REV = 'a140b6ac8bc8f596729e9052819affc779c3b377'
checks = []


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, f'{args[0]} exit {result.returncode}: {result.stderr[-3000:]}'
    return result.stdout + result.stderr


def check(name, fn):
    try:
        detail = fn()
        checks.append({'name': name, 'ok': True, 'detail': detail})
    except Exception as error:
        checks.append({'name': name, 'ok': False, 'error': str(error)})


def versions():
    for tool in ('ffmpeg', 'ffprobe'):
        text = run(tool, '-version')
        assert re.search(rf'^{tool} version 9\.0\.2(?:\s|$)', text), text.splitlines()[0]
    import av
    assert av.__version__ == '19.0.1', av.__version__
    for name, major in EXPECTED.items():
        version = av.library_versions[name]
        assert version[0] == major, f'{name}: {version}, expected ABI {major}'
        library = ctypes.CDLL(f'{name}.so.{major}')
        func = getattr(library, name.removeprefix('lib') + '_version')
        native = func()
        assert tuple(version) == (native >> 16, (native >> 8) & 255, native & 255), name
    maps = Path('/proc/self/maps').read_text()
    loaded = sorted(set(line.split()[-1] for line in maps.splitlines()
                        if any('/' + name + '.so' in line for name in EXPECTED)))
    assert len(loaded) == len(EXPECTED), loaded
    assert all(p.startswith('/opt/media/lib/') for p in loaded), loaded
    assert not any('.libs/' in line or 'av.libs/' in line for line in maps.splitlines()), 'bundled FFmpeg libraries'
    manifest = json.loads(Path('/opt/media/manifest.json').read_text())
    assert manifest['ffmpeg'] == '9.0.2' and manifest['pyav'] == '19.0.1', manifest
    assert manifest['comskip_revision'] == COMSKIP_REV, manifest
    assert os.environ.get('COMSKIP_REVISION') == COMSKIP_REV, 'Comskip detector metadata differs from build'
    return {'pyav': av.__version__, 'libraries': av.library_versions, 'loaded': loaded, 'manifest': manifest}


def capabilities():
    required = {
        '-encoders': ['libx264', 'libx265', 'aac', 'mpeg2video', 'webvtt', 'srt'],
        '-decoders': ['h264', 'hevc', 'mpeg2video', 'aac', 'ac3', 'eac3', 'dca', 'subrip', 'webvtt', 'dvbsub', 'dvdsub'],
        '-demuxers': ['mpegts', 'hls', 'mov', 'matroska', 'concat', 'lavfi'],
        '-muxers': ['mpegts', 'hls', 'mp4', 'matroska', 'webvtt', 'null'],
        '-filters': ['scale', 'trim', 'setpts', 'aresample', 'atrim', 'asetpts', 'testsrc2', 'sine', 'subtitles'],
        '-protocols': ['http', 'https', 'tcp', 'tls', 'pipe', 'file', 'crypto'],
        '-bsfs': ['filter_units', 'dump_extra', 'aac_adtstoasc', 'h264_mp4toannexb', 'hevc_mp4toannexb'],
    }
    for option, names in required.items():
        text = run('ffmpeg', '-hide_banner', option)
        for name in names:
            assert re.search(r'(?<![\w])' + re.escape(name) + r'(?![\w])', text), f'{option} missing {name}'
    return required


def isolation():
    assert os.getuid() != 0, 'runtime must be non-root'
    for tool in ('cc', 'gcc', 'g++', 'make', 'cmake', 'autoconf', 'pkg-config'):
        assert shutil.which(tool) is None, f'runtime contains build tool {tool}'
    application_binary = Path(os.environ.get('COMSKIP_PATH', '/usr/local/bin/comskip'))
    assert application_binary.is_file() and os.access(application_binary, os.X_OK), 'server Comskip path is not executable'
    assert application_binary.resolve() == Path(shutil.which('comskip')).resolve(), 'server and PATH select different Comskip binaries'
    result = run('ldd', str(application_binary))
    assert 'not found' not in result, result
    for name in ('libavcodec', 'libavformat', 'libavutil', 'libswscale'):
        assert re.search(name + r'\.so\.\d+ => /opt/media/lib/', result), f'{name} not linked to /opt/media/lib: {result[:600]}'
    return {'uid': os.getuid(), 'comskip_linkage': result}


def media():
    import av
    with tempfile.TemporaryDirectory(prefix='native-media-') as root:
        root = Path(root)
        source = root / 'source.ts'
        base = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1']
        run(*base, '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=3',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-bf', '0', '-threads', '1',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'mpegts', str(source))
        with av.open(str(source)) as demux:
            decoded = sum(1 for _ in demux.decode(video=0))
        assert decoded == 30, f'PyAV decoded {decoded} frames'
        remux = root / 'remux.ts'
        with av.open(str(source)) as demux, av.open(str(remux), 'w', format='mpegts') as mux:
            streams = {s.index: mux.add_stream_from_template(s) for s in demux.streams}
            for packet in demux.demux():
                if packet.dts is None:
                    continue
                packet.stream = streams[packet.stream.index]
                mux.mux(packet)
        probe = json.loads(run('ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(remux)))
        assert {s['codec_name'] for s in probe['streams']} == {'h264', 'aac'}, probe
        run(*base, '-i', str(remux), '-c', 'copy', '-f', 'hls', '-hls_time', '1',
            '-hls_flags', 'independent_segments', str(root / 'index.m3u8'))
        run(*base, '-i', str(root / 'index.m3u8'), '-f', 'null', '-')
        run(*base, '-i', str(source), '-vf', 'scale=128:72,trim=start_frame=1,setpts=PTS-STARTPTS',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof', str(root / 'fragmented.mp4'))
        subtitle = root / 'caption.srt'
        subtitle.write_text('1\n00:00:00,000 --> 00:00:01,000\nNative smoke caption\n')
        run(*base, '-i', str(subtitle), '-c:s', 'webvtt', str(root / 'caption.vtt'))
        assert 'Native smoke caption' in (root / 'caption.vtt').read_text()
        detector_results = []
        for codec in ('libx264', 'mpeg2video'):
            detector_source = root / (codec + '.ts')
            run(*base, '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=10',
                '-f', 'lavfi', '-i', 'sine=sample_rate=48000:duration=10',
                '-c:v', codec, '-threads', '1', '-c:a', 'aac', '-f', 'mpegts', str(detector_source))
            comskip = subprocess.run(['comskip', '--ini=/etc/comskip/espn.ini', '--output=' + str(root), str(detector_source)],
                                     capture_output=True, text=True, timeout=90)
            output = comskip.stdout + comskip.stderr
            assert comskip.returncode == 0, f'Comskip exit {comskip.returncode}: {output[-3000:]}'
            frames = re.search(r'(\d+) frames decoded', output)
            assert frames and int(frames[1]) >= 200, f'Comskip did not decode {codec}: {output[-3000:]}'
            detector_results.append({'codec': codec, 'decoded_frames': int(frames[1]), 'exit': comskip.returncode})
        return {'decoded_frames': decoded, 'roundtrip_codecs': ['h264', 'aac'],
                'hls': True, 'fragmented_mp4_transcode': True, 'webvtt': True,
                'comskip': detector_results}


for name, fn in [('versions_same_abi', versions), ('required_capabilities', capabilities),
                 ('nonroot_no_compilers', isolation), ('real_media_roundtrip', media)]:
    check(name, fn)
print(json.dumps({'ok': all(c['ok'] for c in checks), 'checks': checks}, indent=2))
raise SystemExit(0 if all(c['ok'] for c in checks) else 1)
