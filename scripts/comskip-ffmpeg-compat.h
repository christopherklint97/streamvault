/* Local API compatibility only; Comskip's classifier and ini remain unchanged. */
#ifndef STREAMVAULT_COMSKIP_FFMPEG_COMPAT_H
#define STREAMVAULT_COMSKIP_FFMPEG_COMPAT_H
#include <stdio.h>
#include <stdlib.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/codec_desc.h>
#include <libavformat/avformat.h>

static int comskip_ticks_per_frame(const AVCodecContext *codec)
{
    /* Preserve upstream's MPEG-1 override, even though FFmpeg's descriptor
       includes FIELDS for its shared MPEG-1/MPEG-2 decoder. APIchanges prescribes
       AV_CODEC_PROP_FIELDS as the decoding replacement for ticks_per_frame. */
    if (codec->codec_id == AV_CODEC_ID_MPEG1VIDEO)
        return 1;
    const AVCodecDescriptor *desc = avcodec_descriptor_get(codec->codec_id);
    return desc && (desc->props & AV_CODEC_PROP_FIELDS) ? 2 : 1;
}

static double comskip_frame_delay(AVFormatContext *format, AVStream *stream,
                                  const AVCodecContext *codec)
{
    /* Decoder time_base is unused in modern FFmpeg. Prefer the bitstream rate,
       then the demuxer's guessed frame rate; never invent a rate or use a
       transport timestamp tick as a whole-frame duration. */
    AVRational rate = codec->framerate;
    if (rate.num <= 0 || rate.den <= 0)
        rate = av_guess_frame_rate(format, stream, NULL);
    if (rate.num <= 0 || rate.den <= 0)
        rate = stream->avg_frame_rate;
    if (rate.num <= 0 || rate.den <= 0) {
        fputs("Comskip: no usable video frame rate\n", stderr);
        exit(1);
    }
    return (double)rate.den / rate.num;
}
#endif
