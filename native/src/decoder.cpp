// SPDX-License-Identifier: GPL-3.0-or-later
#include "decoder.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
#include <libavutil/pixfmt.h>
}

#include "decoder_msdk.h"
#include "log.h"

namespace sidecam {

struct H264Decoder::Hw {
    woc::Decoder dec;
};

struct H264Decoder::State {
    AVCodecContext *ctx = nullptr;
    AVPacket *pkt = nullptr;
    AVFrame *frame = nullptr;
};

namespace {

void quiet_log(void *, int level, const char *fmt, va_list ap)
{
    /* libavcodec reports every concealed picture; only with -v */
    if (level > AV_LOG_ERROR || !cld::log_verbose)
        return;
    char line[256];
    std::vsnprintf(line, sizeof line, fmt, ap);
    size_t n = std::strlen(line);
    while (n && (line[n - 1] == '\n' || line[n - 1] == '\r'))
        line[--n] = 0;
    if (n)
        log_debug("libavcodec: %s", line);
}

}  // namespace

H264Decoder::H264Decoder() {}
H264Decoder::~H264Decoder()
{
    close();
    if (hw_) {
        hw_->dec.shutdown();
        delete hw_;
        hw_ = nullptr;
    }
}

namespace {

/* The first user-data-unregistered SEI of an access unit (UUID and payload,
 * at most 40 bytes) as hex, like libavcodec's side data; empty without one. */
std::string au_sei_hex(const uint8_t *d, size_t n, bool *idr)
{
    std::string out;
    *idr = false;
    size_t i = 0;
    while (i + 3 < n) {
        if (!(d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1)) { i++; continue; }
        size_t s = i + 3;
        size_t e = s;
        while (e + 2 < n && !(d[e] == 0 && d[e + 1] == 0 && (d[e + 2] == 1 || d[e + 2] == 0))) e++;
        if (e + 2 >= n) e = n;
        if (s < e) {
            const int type = d[s] & 31;
            if (type == 5) *idr = true;
            if (type == 6 && out.empty()) {
                std::vector<uint8_t> rb;   /* emulation prevention removed */
                rb.reserve(e - s);
                int zeros = 0;
                for (size_t k = s + 1; k < e; k++) {
                    if (zeros >= 2 && d[k] == 3) { zeros = 0; continue; }
                    zeros = d[k] == 0 ? zeros + 1 : 0;
                    rb.push_back(d[k]);
                }
                size_t p = 0;
                while (p + 2 <= rb.size() && rb[p] != 0x80) {
                    unsigned pt = 0, ps = 0;
                    while (p < rb.size() && rb[p] == 0xff) { pt += 255; p++; }
                    if (p >= rb.size()) break;
                    pt += rb[p++];
                    while (p < rb.size() && rb[p] == 0xff) { ps += 255; p++; }
                    if (p >= rb.size()) break;
                    ps += rb[p++];
                    if (p + ps > rb.size()) break;
                    if (pt == 5) {
                        static const char hex[] = "0123456789abcdef";
                        const size_t m = ps < 40 ? ps : 40;
                        for (size_t k = 0; k < m; k++) {
                            out.push_back(hex[rb[p + k] >> 4]);
                            out.push_back(hex[rb[p + k] & 15]);
                        }
                        break;
                    }
                    p += ps;
                }
            }
        }
        i = e;
    }
    return out;
}

}  // namespace

std::string H264Decoder::version()
{
    char b[96];
    const unsigned v = avcodec_version();
    std::snprintf(b, sizeof b, "Intel MSDK (hardware) + libavcodec %u.%u.%u (fallback)", v >> 16, (v >> 8) & 255, v & 255);
    return b;
}

bool H264Decoder::open(std::string *err)
{
    close();
    const char *want = std::getenv("SIDECAM_DECODER");
    if (!(want && std::strcmp(want, "sw") == 0)) {
        if (hw_) {
            hw_->dec.shutdown();
            delete hw_;
        }
        hw_ = new Hw();
        std::string e;
        /* GPU copy (MSDK's CM copy) of each picture to system memory; SIDECAM_GPU_COPY=0: on the CPU */
        const char *gc = std::getenv("SIDECAM_GPU_COPY");
        const bool gpu_copy = !(gc && std::strcmp(gc, "0") == 0);
        if (hw_->dec.init("/dev/dri/renderD128", 0, 0, 0, gpu_copy, &e)) {
            hw_active_ = true;
            hw_fails_ = 0;
            log_info("decoder: hardware (Intel MSDK)%s", gpu_copy ? ", GPU copy" : "");
            return true;
        }
        log_warn("decoder: hardware unavailable (%s), using libavcodec", e.c_str());
        delete hw_;
        hw_ = nullptr;
    }
    hw_active_ = false;
    return open_sw(err);
}

bool H264Decoder::open_sw(std::string *err)
{
    close();
    av_log_set_callback(quiet_log);
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) {
        *err = "libavcodec has no H.264 decoder";
        return false;
    }
    s_ = new State();
    s_->ctx = avcodec_alloc_context3(codec);
    s_->pkt = av_packet_alloc();
    s_->frame = av_frame_alloc();
    if (!s_->ctx || !s_->pkt || !s_->frame) {
        *err = "out of memory";
        close();
        return false;
    }
    /* Every picture out as soon as it is decoded, damaged ones and the ones
     * before the first keyframe too: a camera view late or frozen is worse
     * than one with a blemish. */
    s_->ctx->flags |= AV_CODEC_FLAG_LOW_DELAY | AV_CODEC_FLAG_OUTPUT_CORRUPT;
    s_->ctx->flags2 |= AV_CODEC_FLAG2_SHOW_ALL | AV_CODEC_FLAG2_FAST;
    s_->ctx->thread_count = 2;
    s_->ctx->thread_type = FF_THREAD_SLICE;   /* frame threads would hold pictures back */
    s_->ctx->err_recognition = 0;
    s_->ctx->skip_loop_filter = idle_ ? AVDISCARD_ALL : AVDISCARD_DEFAULT;
    s_->ctx->skip_frame = AVDISCARD_DEFAULT;
    int r = avcodec_open2(s_->ctx, codec, nullptr);
    if (r < 0) {
        char e[128];
        av_strerror(r, e, sizeof e);
        *err = std::string("avcodec_open2: ") + e;
        close();
        return false;
    }
    fails_ = 0;
    return true;
}

int H264Decoder::decode_hw(const uint8_t *data, size_t len, const Sink &sink)
{
    bool idr = false;
    /* Idle, still two pictures in a row out of every 15 access units (both
     * halves of a paired stream, ~4 a second): the app shows a view only
     * while the helper's pictures keep coming (picture_age_ms, pair). */
    const bool want_picture = !idle_ || (idle_n_++ % 15) < 2;
    std::string sei;
    if (want_picture)
        sei = au_sei_hex(data, len, &idr);
    if (want_picture)
        hw_->dec.forget_last();   /* every picture with its planes, even one equal to the last */
    int pictures = 0;
    std::string e;
    const bool ok = hw_->dec.feed(data, len, [&](const woc::VideoFrame &f) {
        if (!f.atlas || f.w < 32 || f.h < 32 || (f.w & 1) || (f.h & 1))
            return;
        const uint8_t *a = f.atlas->data();
        DecodedFrame d;
        d.planes.y = a;
        d.planes.u = a + (size_t)f.w * f.h;
        d.planes.v = a + (size_t)f.w * f.h + f.w / 2;
        d.planes.y_stride = (int)f.w;
        d.planes.c_stride = (int)f.w;
        d.planes.w = (int)f.w;
        d.planes.h = (int)f.h;
        d.planes.full_range = false;   /* the camera unit's stream: studio levels (status full_range 0 with libavcodec) */
        d.key = idr;
        d.corrupt = f.corrupted != 0;
        d.sei = sei;
        sink(d);
        pictures++;
    }, &e, true, want_picture);
    if (!ok) {
        errors_++;
        if (++hw_fails_ >= kFailLimit) {
            log_warn("decoder: hardware failed %d access units in a row (%s), falling back to libavcodec", hw_fails_, e.c_str());
            restarts_++;
            hw_->dec.shutdown();
            delete hw_;
            hw_ = nullptr;
            hw_active_ = false;
            std::string err;
            if (!open_sw(&err))
                log_error("decoder: %s", err.c_str());
        }
        return pictures ? pictures : -1;
    }
    hw_fails_ = 0;
    return pictures;
}

void H264Decoder::set_idle(bool idle)
{
    if (idle_ == idle)
        return;
    idle_ = idle;
    if (s_ && s_->ctx) {
        s_->ctx->skip_loop_filter = idle_ ? AVDISCARD_ALL : AVDISCARD_DEFAULT;
    }
}

void H264Decoder::close()
{
    if (!s_)
        return;
    if (s_->frame)
        av_frame_free(&s_->frame);
    if (s_->pkt)
        av_packet_free(&s_->pkt);
    if (s_->ctx)
        avcodec_free_context(&s_->ctx);
    delete s_;
    s_ = nullptr;
}

int H264Decoder::decode(const uint8_t *data, size_t len, const Sink &sink)
{
    if (hw_active_ && hw_ && len)
        return decode_hw(data, len, sink);
    return decode_sw(data, len, sink);
}

int H264Decoder::decode_sw(const uint8_t *data, size_t len, const Sink &sink)
{
    if (!s_ || !len)
        return -1;
    buf_.resize(len + AV_INPUT_BUFFER_PADDING_SIZE);
    std::memcpy(buf_.data(), data, len);
    std::memset(buf_.data() + len, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    s_->pkt->data = buf_.data();
    s_->pkt->size = (int)len;
    int r = avcodec_send_packet(s_->ctx, s_->pkt);
    int pictures = 0;
    bool failed = r < 0 && r != AVERROR(EAGAIN);
    for (;;) {
        int g = avcodec_receive_frame(s_->ctx, s_->frame);
        if (g < 0)
            break;
        const AVFrame *f = s_->frame;
        if ((f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P) && f->width >= 32 && f->height >= 32 &&
            !(f->width & 1) && !(f->height & 1) && f->linesize[0] > 0 && f->linesize[1] > 0 &&
            f->linesize[1] == f->linesize[2]) {
            DecodedFrame d;
            d.planes.y = f->data[0];
            d.planes.u = f->data[1];
            d.planes.v = f->data[2];
            d.planes.y_stride = f->linesize[0];
            d.planes.c_stride = f->linesize[1];
            d.planes.w = f->width;
            d.planes.h = f->height;
            d.planes.full_range = f->format == AV_PIX_FMT_YUVJ420P || f->color_range == AVCOL_RANGE_JPEG;
            d.key = (f->flags & AV_FRAME_FLAG_KEY) != 0;
            d.corrupt = (f->flags & AV_FRAME_FLAG_CORRUPT) != 0 || f->decode_error_flags != 0;
            const AVFrameSideData *sd = av_frame_get_side_data(f, AV_FRAME_DATA_SEI_UNREGISTERED);
            if (sd && sd->data) {
                static const char hex[] = "0123456789abcdef";
                const size_t n = sd->size < 40 ? sd->size : 40;
                for (size_t i = 0; i < n; i++) {
                    d.sei.push_back(hex[sd->data[i] >> 4]);
                    d.sei.push_back(hex[sd->data[i] & 15]);
                }
            }
            sink(d);
            pictures++;
        } else {
            failed = true;   /* not 8-bit 4:2:0: nothing this program can show */
        }
        av_frame_unref(s_->frame);
    }
    if (failed) {
        errors_++;
        if (++fails_ >= kFailLimit) {
            /* a sequence it cannot follow: a new decoder, from the next parameter sets */
            std::string err;
            restarts_++;
            log_warn("decoder: %d access units failed in a row, starting again", fails_);
            if (!open_sw(&err))
                log_error("decoder: %s", err.c_str());
        }
        return pictures ? pictures : -1;
    }
    if (pictures)
        fails_ = 0;
    return pictures;
}

}  // namespace sidecam
