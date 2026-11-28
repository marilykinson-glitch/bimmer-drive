# xinhan-cam: licenses

`mgu-sidecam` (the program) as a whole is **GPL-3.0-or-later**. Its complete source, the build
script and the tests are in this repository under `native/`.

It contains:

- `native/src/` - this project's own code, GPL-3.0-or-later.
- From [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
  (commit `090dc8b7`), in `native/third_party/idrive-apps/` (unchanged but for the receiver's
  name in `avb_source.cpp`, marked there):
  `waze-on-cluster/src/avb_source.*`, `rtp_h264.*`, `packet_queue.h` and
  `cluster-render/src/log.*` (GPL-3.0-or-later, Copyright (C) 2026 Robert Nisipeanu), and the
  cluster renderer's client `cluster-render/client/*`, `include/cluster_render/*` (MPL-2.0,
  Copyright (C) 2026 Robert Nisipeanu). Texts: `LICENSE.GPL-3.0`, `LICENSE.MPL-2.0`.
- From robertnisipeanu/idrive-apps (commit `f3380392`), in `native/third_party/idrive-apps/msdk/`
  (unchanged): the hardware H.264 decoder `waze-on-cluster/src/decoder_msdk.*` with `nal_reader.*`,
  `bit_reader.h`, `map_rect.h`, `source_crop.h` and its MSDK/VA-API ABI headers and export lists
  (GPL-3.0-or-later; `abi/include/mfx` under its own LICENSE), and `cluster-render/kit/frame_clock.h`,
  `yuv_atlas.*` (MPL-2.0).
- FFmpeg 7.1's libavcodec and libavutil (H.264 decoder only), LGPL-2.1-or-later, built without
  GPL or nonfree parts and linked statically (`native/build.sh` has the exact configuration;
  the source is https://github.com/FFmpeg/FFmpeg, tag `n7.1`). Text: `LICENSE.ffmpeg`. You may
  rebuild `mgu-sidecam` with a changed FFmpeg from the source here.
- GCC's libstdc++ and libgcc (GPL-3.0 with the GCC Runtime Library Exception), linked statically.

At run time it uses the head unit's own IAS AVB bridge library, its Intel Media SDK
(`libmfxhw64.so`) and VA-API (`libva.so.1`, `libva-drm.so.1`) for hardware decoding and talks to cluster-render
over its socket; neither is part of this program or shipped with it.

`xinhan-cam.js` (the service script): MIT, as the app kit in this repository (`kit/LICENSE`).

`nav.js` (the navigation reader): MIT, this project's. `oapgen-gen.js` is `kit/tools/oapgen/gen.js` of
the app kit (MIT, Copyright (c) 2026 cauliflowermossgrape), unchanged: it loads the head unit's own
interface generator from the unit's firmware at run time; nothing of BMW's is shipped here.
