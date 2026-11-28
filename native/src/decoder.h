// SPDX-License-Identifier: GPL-3.0-or-later
/* H.264 decoder: one access unit of Annex-B bytes in, decoded 4:2:0
 * pictures out, each as soon as it is decoded.
 *
 * First choice: the head unit's own hardware decoder (Intel Media SDK over
 * VA-API, third_party/idrive-apps/msdk). Measured on the car (G30, 1280x480
 * at 30 a second): it starts on the camera stream within 0.11 s (an SPS
 * comes with every picture), decodes it without errors, and costs ~15% of
 * one core against ~50% for libavcodec. While idle (no view wanted) it
 * decodes on the GPU without fetching pictures, so references stay warm and
 * a view still comes up at the next picture; it still fetches two
 * pictures in a row out of every 15 so the status stays alive. SIDECAM_DECODER=sw, an init
 * failure or kFailLimit failures in a row fall back to libavcodec for the
 * rest of the process.
 *
 * Fallback, as before:
 * Software on purpose: the camera unit's stream is not what the head unit's
 * hardware decoder is used to (it may carry no IDR pictures at all, only a
 * rolling intra refresh), and a decoder that never starts shows nothing.
 * libavcodec starts at the first parameter sets and shows pictures from
 * there, also before the first keyframe (they clear up as the refresh goes
 * round). 1280x960 at 15 pictures a second is a small part of one core.
 *
 * Not thread-safe: one thread calls it. */
#ifndef SIDECAM_DECODER_H
#define SIDECAM_DECODER_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <string>
#include <vector>

#include "resample.h"

namespace sidecam {

struct DecodedFrame {
    Planes planes;
    bool key = false;        /* a keyframe */
    bool corrupt = false;    /* decoded with concealed errors */
    std::string sei;         /* the picture's first unregistered user-data SEI, hex, at most 40 bytes */
};

class H264Decoder {
public:
    using Sink = std::function<void(const DecodedFrame &)>;
    /* Access units that fail in a row before the decoder is made again. */
    static const int kFailLimit = 30;

    H264Decoder();
    ~H264Decoder();
    H264Decoder(const H264Decoder &) = delete;
    H264Decoder &operator=(const H264Decoder &) = delete;

    bool open(std::string *err);
    /* "msdk" or "libavcodec": the decoder in use. */
    const char *backend() const { return hw_active_ ? "msdk" : "libavcodec"; }
    void close();
    /* Idle mode: skips H.264 loop deblocking filter and non-ref frames while keeping DPB reference frames warm. */
    void set_idle(bool idle);
    /* One whole access unit, every NAL unit behind a start code. Returns the
     * pictures it gave, or -1 when the access unit failed to decode. */
    int decode(const uint8_t *data, size_t len, const Sink &sink);

    uint64_t errors() const { return errors_; }
    uint64_t restarts() const { return restarts_; }
    /* libavcodec's name and version, for the log. */
    static std::string version();

private:
    struct State;
    struct Hw;
    bool open_sw(std::string *err);
    int decode_sw(const uint8_t *data, size_t len, const Sink &sink);
    int decode_hw(const uint8_t *data, size_t len, const Sink &sink);
    State *s_ = nullptr;
    Hw *hw_ = nullptr;
    bool hw_active_ = false;
    int hw_fails_ = 0;
    uint32_t idle_n_ = 0;
    std::vector<uint8_t> buf_;
    bool idle_ = true;
    int fails_ = 0;
    uint64_t errors_ = 0, restarts_ = 0;
};

}  // namespace sidecam

#endif
