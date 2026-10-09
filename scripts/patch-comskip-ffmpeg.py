#!/usr/bin/python3
"""Strict, reproducible API-only patch for the pinned upstream Comskip source."""
import hashlib
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1]) / 'mpeg2dec.c'
original = source.read_bytes()
expected = '9bda63e0299731bdca155d5887764284ab6722324097ea1500675b3fbb4a8399'
assert hashlib.sha256(original).hexdigest() == expected, 'Comskip source changed; review compatibility patch'
text = original.decode().replace('\r\n', '\n')
anchor = '#include <libavcodec/avcodec.h>\n'
assert text.count(anchor) == 1
text = text.replace(anchor, anchor + '#include "comskip-ffmpeg-compat.h"\n')
# Preserve the existing MPEG-1 override inside the helper rather than assigning
# a member removed in libavcodec 62. No classifier/configuration changes.
assignment = '        if (codecCtx->codec_id == AV_CODEC_ID_MPEG1VIDEO)\n            is->dec_ctx->ticks_per_frame = 1;'
assert text.count(assignment) == 1
text = text.replace(assignment, '        /* MPEG-1 tick override lives in comskip_ticks_per_frame(). */')
duration = 'av_q2d(is->dec_ctx->time_base) * is->dec_ctx->ticks_per_frame'
assert text.count(duration) == 4
text = text.replace(duration, 'comskip_frame_delay(is->pFormatCtx, is->video_st, is->dec_ctx)')
assert text.count('is->dec_ctx->ticks_per_frame') == 10
text = text.replace('is->dec_ctx->ticks_per_frame', 'comskip_ticks_per_frame(is->dec_ctx)')
source.write_text(text)
shutil.copy2(Path(__file__).with_name('comskip-ffmpeg-compat.h'), source.with_name('comskip-ffmpeg-compat.h'))
print('Applied strict Comskip FFmpeg timing API compatibility patch')
