# Intel MSDK hardware H.264 decoder (vendored)

From robertnisipeanu/idrive-apps @ f33803925d90d8a7db3f58b466bf2e3a05ac0fd3:

- `src/decoder_msdk.*`, `src/nal_reader.*`, `src/bit_reader.h`, `src/map_rect.h`, `src/source_crop.h`
  and `abi/` from `native/waze-on-cluster` (GPL-3.0-or-later; `abi/include/mfx` keeps its own LICENSE).
- `kit/frame_clock.h`, `kit/yuv_atlas.*` from `native/cluster-render/kit` (MPL-2.0).

Unmodified. Used by `src/decoder.cpp` (the head unit's MSDK over VA-API; libavcodec stays the fallback).
