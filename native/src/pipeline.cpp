// SPDX-License-Identifier: GPL-3.0-or-later
#include "pipeline.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <unistd.h>

#include "log.h"

namespace sidecam {

namespace {
int64_t now_us()
{
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

bool view_uses_half(const ViewSpec &vs, int cls)
{
    return cls == 0 ? (vs.y < 500) : ((vs.y + vs.h) > 500);
}
}  // namespace

const char *view_name(View v)
{
    switch (v) {
    case kLeft: return "left";
    case kRight: return "right";
    case kAll: return "all";
    case kFront: return "front";
    default: return "none";
    }
}

View view_from(const std::string &name)
{
    if (name == "left") return kLeft;
    if (name == "right") return kRight;
    if (name == "all") return kAll;
    if (name == "front") return kFront;
    return kNone;
}

/* About 4 s of a 5 Mbit/s stream, as the receive side of waze-on-cluster. */
Pipeline::Pipeline() : queue_(4096, 6 << 20) {}
Pipeline::~Pipeline() { stop(); }

bool Pipeline::start(int wake_fd, std::string *err)
{
    wake_fd_ = wake_fd;
    if (!dec_.open(err))
        return false;
    rtp_.on_gap = [this](const woc::RtpH264::Gap &g) {
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.lost += g.lost;
    };
    running_ = true;
    thread_ = std::thread([this] { loop(); });
    return true;
}

void Pipeline::stop()
{
    avb_.stop();
    joined_ = false;
    if (running_.exchange(false)) {
        queue_.close();
        if (thread_.joinable())
            thread_.join();
    }
    dec_.close();
}

bool Pipeline::join(const std::string &stream, std::string *err)
{
    if (joined_)
        return true;
    joined_ = avb_.start(stream, [this](const uint8_t *d, size_t n) { push(d, n); }, err);
    std::lock_guard<std::mutex> lock(mutex_);
    avb_state_ = joined_ ? "ok" : *err;
    return joined_;
}

void Pipeline::push(const uint8_t *pkt, size_t len)
{
    if (!len || len > 65536)
        return;
    queue_.push(pkt, len, 0);
}

uint32_t Pipeline::set_output(const Output &o)
{
    std::lock_guard<std::mutex> lock(mutex_);
    out_ = o;
    fresh_view_ = true;
    have_ready_ = false;
    return ++gen_;
}

void Pipeline::set_view(View v)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (v == view_)
        return;
    view_ = v;
    fresh_view_ = true;
    have_ready_ = false;
}

uint32_t Pipeline::set_aux(const Aux &a)
{
    std::lock_guard<std::mutex> lock(mutex_);
    aux_ = a;
    aux_have_ = false;
    aux_fresh_ = true;
    return ++aux_gen_;
}

bool Pipeline::take_aux(std::vector<uint8_t> *atlas, AtlasMeta *meta)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!aux_have_)
        return false;
    atlas->swap(aux_ready_);
    *meta = aux_meta_;
    aux_have_ = false;
    return true;
}

void Pipeline::set_overlay(const Overlay &o)
{
    std::lock_guard<std::mutex> lock(mutex_);
    overlay_ = o;
}

void Pipeline::request_snap(const std::string &path)
{
    std::lock_guard<std::mutex> lock(mutex_);
    snap_req_path_ = path;
}

bool Pipeline::take_snap_result(bool *ok, int *w, int *h, std::string *path)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!snap_done_)
        return false;
    *ok = snap_ok_;
    *w = snap_w_;
    *h = snap_h_;
    *path = snap_done_path_;
    snap_done_ = false;
    return true;
}

bool Pipeline::take(std::vector<uint8_t> *atlas, AtlasMeta *meta)
{
    std::lock_guard<std::mutex> lock(mutex_);
    if (!have_ready_)
        return false;
    atlas->swap(ready_);
    *meta = ready_meta_;
    have_ready_ = false;
    return true;
}

Stats Pipeline::stats()
{
    Stats s;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        s = stats_;
        s.avb = avb_state_;
    }
    s.dropped = queue_.overflows();
    return s;
}

void Pipeline::loop()
{
    woc::PacketQueue::Packet pkt;
    const woc::RtpH264::Sink sink = [this](const uint8_t *nal, size_t len, bool end_of_au) {
        if (len)
            au_.insert(au_.end(), nal, nal + len);
        if (!end_of_au || au_.empty())
            return;
        bool idle = false;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            idle = (view_ == kNone && snap_req_path_.empty());
        }
        dec_.set_idle(idle);
        const int64_t t0 = now_us();
        const int r = dec_.decode(au_.data(), au_.size(), [this](const DecodedFrame &f) { on_picture(f); });
        const int64_t t1 = now_us();
        au_.clear();
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.access_units++;
        stats_.decode_errors = dec_.errors();
        stats_.restarts = dec_.restarts();
        stats_.decoder = dec_.backend();
        if (r > 0)
            stats_.decode_us = (int)(t1 - t0);
    };
    while (running_.load()) {
        if (!queue_.pop(&pkt, 200))
            continue;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            stats_.packets++;
            stats_.bytes += pkt.data.size();
        }
        rtp_.push(pkt.data.data(), pkt.data.size(), sink);
        /* an access unit that never ends (a stream cut off mid-picture) must not grow for ever */
        if (au_.size() > (8u << 20))
            au_.clear();
    }
}

void Pipeline::on_picture(const DecodedFrame &f)
{
    const int64_t now = cld::now_ms();
    Output out;
    View view;
    Aux aux;
    uint32_t gen, agen;
    bool fresh, afresh;
    std::string snap_path;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.pictures++;
        stats_.corrupt += f.corrupt;
        stats_.keyframes += f.key;
        stats_.w = f.planes.w;
        stats_.h = f.planes.h;
        stats_.full_range = f.planes.full_range;
        stats_.picture_ms = now;
        if (!f.sei.empty()) {
            if (f.sei != stats_.sei)
                stats_.sei_prev = stats_.sei;
            stats_.sei = f.sei;
        }
        out = out_;
        view = view_;
        gen = gen_;
        fresh = fresh_view_;
        aux = aux_;
        agen = aux_gen_;
        afresh = aux_fresh_;
        snap_path = snap_req_path_;
    }
    /* Two pictures by turns: which one this is (always, so the tag is known when a view comes on) */
    const bool pairing = out.pair && (int64_t)f.planes.w * 2 >= (int64_t)f.planes.h * 5;
    int cls = 0;
    if (pairing)
        cls = tagger_.classify(f.sei) ^ (out.pair_swap ? 1 : 0);
    {
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.pair = pairing ? tagger_.mode() : "off";
    }
    /* the source is whole: a picture, or both kinds by turns, each lately (also with no view on, so a
     * view that comes on is not taken for a stopped camera before its first picture) */
    if (pairing)
        seen_ms_[cls] = now;
    const bool both_seen = !pairing || (seen_ms_[cls ^ 1] >= 0 && now - seen_ms_[cls ^ 1] <= 650);
    if (both_seen) {
        std::lock_guard<std::mutex> lock(mutex_);
        stats_.source_ms = now;
    }
    if (view == kNone && snap_path.empty()) {
        pair_have_[0] = pair_have_[1] = false;
        return;
    }
    const bool need_both = !snap_path.empty() || view == kAll;
    const bool need_half0 = !pairing || need_both || (view != kNone && view_uses_half(out.views[view], 0)) ||
                            (view != kNone && aux.on && view_uses_half(aux.vs, 0));
    const bool need_half1 = !pairing || need_both || (view != kNone && view_uses_half(out.views[view], 1)) ||
                            (view != kNone && aux.on && view_uses_half(aux.vs, 1));
    const bool need_cur = cls == 0 ? need_half0 : need_half1;
    Planes src = f.planes;
    if (pairing) {
        if (!both_seen)
            return;
        const int w = f.planes.w, h = f.planes.h;
        if (w != pair_w_ || h != pair_h_) {
            pair_w_ = w;
            pair_h_ = h;
            pair_y_.assign((size_t)w * h * 2, 0);
            pair_u_.assign((size_t)(w / 2) * h, 128);
            pair_v_.assign((size_t)(w / 2) * h, 128);
            pair_have_[0] = pair_have_[1] = false;
        }
        if (need_cur) {
            for (int r = 0; r < h; r++)
                std::memcpy(&pair_y_[(size_t)(cls * h + r) * w], f.planes.y + (size_t)r * f.planes.y_stride, (size_t)w);
            for (int r = 0; r < h / 2; r++) {
                std::memcpy(&pair_u_[(size_t)(cls * (h / 2) + r) * (w / 2)], f.planes.u + (size_t)r * f.planes.c_stride, (size_t)(w / 2));
                std::memcpy(&pair_v_[(size_t)(cls * (h / 2) + r) * (w / 2)], f.planes.v + (size_t)r * f.planes.c_stride, (size_t)(w / 2));
            }
            pair_have_[cls] = true;
            pair_ms_[cls] = now;
        }
        if ((need_half0 && (!pair_have_[0] || now - pair_ms_[0] > 650)) ||
            (need_half1 && (!pair_have_[1] || now - pair_ms_[1] > 650)))
            return;
        src.y = pair_y_.data();
        src.u = pair_u_.data();
        src.v = pair_v_.data();
        src.y_stride = w;
        src.c_stride = w / 2;
        src.h = h * 2;
    }
    /* One-shot 4-camera snapshot (960x720 YUV420 atlas) when requested */
    if (!snap_path.empty() && (!pairing || (pair_have_[0] && pair_have_[1] && now - pair_ms_[0] <= 650 && now - pair_ms_[1] <= 650))) {
        ViewSpec all_vs;
        all_vs.x = 0; all_vs.y = 0; all_vs.w = 1000; all_vs.h = 1000; all_vs.rot = 0; all_vs.flip = false; all_vs.round = false; all_vs.sar = 100;
        const int sw = 960, sh = 720;
        bool wrote = false;
        if (snap_resampler_.matches(src.w, src.h, all_vs, sw, sh) || snap_resampler_.build(src.w, src.h, all_vs, sw, sh)) {
            snap_work_.resize(atlas_bytes(sw, sh));
            snap_resampler_.run(src, snap_work_.data());
            const std::string tmp = snap_path + ".tmp";
            FILE *fp = std::fopen(tmp.c_str(), "wb");
            if (fp) {
                if (std::fwrite(snap_work_.data(), 1, snap_work_.size(), fp) == snap_work_.size() && std::fflush(fp) == 0) {
                    std::fclose(fp);
                    wrote = (std::rename(tmp.c_str(), snap_path.c_str()) == 0);
                } else {
                    std::fclose(fp);
                }
                if (!wrote)
                    std::remove(tmp.c_str());
            }
        }
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (snap_req_path_ == snap_path)
                snap_req_path_.clear();
            snap_done_ = true;
            snap_ok_ = wrote;
            snap_w_ = sw;
            snap_h_ = sh;
            snap_done_path_ = snap_path;
        }
        if (wake_fd_ >= 0) {
            const uint64_t one = 1;
            ssize_t n = ::write(wake_fd_, &one, sizeof one);
            (void)n;
        }
        if (view == kNone)
            return;
    }
    /* the second view, at its own pace (only when its camera half actually updated) */
    bool woke_aux = false;
    if (aux.on && (!pairing || afresh || view_uses_half(aux.vs, cls))) {
        const int64_t ap = aux.fps ? 1000 / (int64_t)aux.fps : 0;
        if (afresh || !ap || now - aux_due_ms_ > 4 * ap)
            aux_due_ms_ = now;
        if (now + ap / 8 >= aux_due_ms_) {
            aux_due_ms_ += ap;
            if (aux_resampler_.matches(src.w, src.h, aux.vs, aux.w, aux.h) || aux_resampler_.build(src.w, src.h, aux.vs, aux.w, aux.h)) {
                const int64_t a0 = now_us();
                aux_work_.resize(atlas_bytes(aux.w, aux.h));
                aux_resampler_.run(src, aux_work_.data());
                std::lock_guard<std::mutex> lock(mutex_);
                stats_.aux_us = (int)(now_us() - a0);
                if (agen == aux_gen_) {
                    aux_ready_.swap(aux_work_);
                    aux_meta_.view = kNone;
                    aux_meta_.id = next_id_++;
                    aux_meta_.w = aux.w;
                    aux_meta_.h = aux.h;
                    aux_meta_.gen = agen;
                    aux_meta_.ms = now;
                    aux_have_ = true;
                    aux_fresh_ = false;
                    woke_aux = true;
                }
            }
        }
    }
    auto wake_main = [this]() {
        if (wake_fd_ >= 0) {
            const uint64_t one = 1;
            ssize_t n = ::write(wake_fd_, &one, sizeof one);
            (void)n;
        }
    };
    if (view == kNone) {
        if (woke_aux)
            wake_main();
        return;
    }
    /* Skip redundant resampling when the other alternating camera half arrived and our view wasn't touched */
    if (pairing && !fresh && view != kAll && !view_uses_half(out.views[view], cls)) {
        if (woke_aux)
            wake_main();
        return;
    }
    /* At most fps views a second, evenly: each view is due one period after
     * the last was due (not after it was made), so 12 a second out of a
     * 15-a-second stream is four pictures of five, not every other one. */
    const int64_t period = out.fps ? 1000 / (int64_t)out.fps : 0;
    if (fresh || !period || now - next_due_ms_ > 4 * period)
        next_due_ms_ = now;
    if (now + period / 8 < next_due_ms_) {
        if (woke_aux)
            wake_main();
        return;
    }
    next_due_ms_ += period;
    const int64_t t0 = now_us();
    const ViewSpec &vs = out.views[view];
    if (!resampler_.matches(src.w, src.h, vs, out.w, out.h) && !resampler_.build(src.w, src.h, vs, out.w, out.h)) {
        log_warn("view %s: a %dx%d picture cannot be made %dx%d", view_name(view), src.w, src.h, out.w, out.h);
        return;
    }
    work_.resize(atlas_bytes(out.w, out.h));
    resampler_.run(src, work_.data());
    if (view == kFront) {
        Overlay ov;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            ov = overlay_;
        }
        draw_overlay(work_.data(), out.w, out.h, ov, now);
    }
    const int64_t t1 = now_us();
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (gen != gen_ || view != view_)
            return;   /* the setting changed while this one was made */
        ready_.swap(work_);
        ready_meta_.view = view;
        ready_meta_.id = next_id_++;
        ready_meta_.w = out.w;
        ready_meta_.h = out.h;
        ready_meta_.gen = gen;
        ready_meta_.ms = now;
        have_ready_ = true;
        fresh_view_ = false;
        stats_.atlases++;
        stats_.view_us = (int)(t1 - t0);
    }
    if (wake_fd_ >= 0) {
        const uint64_t one = 1;
        ssize_t n = ::write(wake_fd_, &one, sizeof one);
        (void)n;
    }
}

}  // namespace sidecam
