/* Regression gate for Comskip's FFmpeg 8+ removed ticks_per_frame API. */
#include <assert.h>
#include <math.h>
#include <sys/wait.h>
#include <unistd.h>
#include "comskip-ffmpeg-compat.h"

int main(void)
{
    AVFormatContext *format = avformat_alloc_context();
    AVStream *stream = avformat_new_stream(format, NULL);
    AVCodecContext *codec = avcodec_alloc_context3(NULL);
    assert(format && stream && codec);
    codec->codec_id = AV_CODEC_ID_H264;
    assert(comskip_ticks_per_frame(codec) == 2);
    codec->codec_id = AV_CODEC_ID_MPEG2VIDEO;
    assert(comskip_ticks_per_frame(codec) == 2);
    codec->codec_id = AV_CODEC_ID_MPEG1VIDEO;
    assert(comskip_ticks_per_frame(codec) == 1); /* upstream explicit override */
    codec->codec_id = AV_CODEC_ID_HEVC;
    assert(comskip_ticks_per_frame(codec) == 1);
    codec->codec_id = AV_CODEC_ID_MJPEG;
    assert(comskip_ticks_per_frame(codec) == 1);

    codec->framerate = (AVRational){25, 1};
    codec->time_base = (AVRational){0, 1}; /* decoder time_base is unused */
    assert(fabs(comskip_frame_delay(format, stream, codec) - .04) < 1e-12);
    codec->framerate = (AVRational){30000, 1001};
    assert(fabs(comskip_frame_delay(format, stream, codec) - 1001.0/30000) < 1e-12);
    codec->framerate = (AVRational){0, 1};
    stream->r_frame_rate = (AVRational){24000, 1001};
    assert(fabs(comskip_frame_delay(format, stream, codec) - 1001.0/24000) < 1e-12);
    stream->r_frame_rate = (AVRational){0, 1};
    stream->avg_frame_rate = (AVRational){25, 1};
    assert(fabs(comskip_frame_delay(format, stream, codec) - .04) < 1e-12);
    stream->avg_frame_rate = (AVRational){0, 1};
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
        comskip_frame_delay(format, stream, codec);
        _exit(0);
    }
    int status;
    assert(waitpid(child, &status, 0) == child);
    assert(WIFEXITED(status) && WEXITSTATUS(status) == 1);
    avcodec_free_context(&codec);
    avformat_free_context(format);
    puts("Comskip FFmpeg timing compatibility tests passed");
    return 0;
}
