---
title: getting the M5StickS3 internal speaker working at 16kHz
---

The M5StickS3 has a built-in speaker driven by an ES8311 codec connected to the ESP32-S3 over I2S. M5Unified wraps all of this — call `M5.Speaker.playRaw()` and it should just work. In practice, three separate bugs caused complete silence, and each one looked like audio was playing but nothing came out.

## Bug 1: board detection always falls back to AtomS3RExt

M5Unified detects which board it's running on at startup by scanning I2C for known power management ICs. On the M5StickS3, the M5PM1 power IC sits at address `0x6E` on internal I2C (SDA=GPIO47, SCL=GPIO48). If that scan fails — timing issue, bus contention, anything — the detection code for the ESP32-S3-PICO-1 (LGA56 package) falls through to an unconditional assignment:

```cpp
// in M5Unified.cpp, case 1 (LGA56):
if (board == board_t::board_unknown) {
    board = board_t::board_M5AtomS3RExt;
    // ... camera probe follows
}
```

The library has a `config_t::fallback_board` field for exactly this situation. But the `begin()` function only uses it when `_check_boardtype()` returns `board_unknown`:

```cpp
auto board = _check_boardtype(Display.getBoard());
if (board == board_t::board_unknown) { board = cfg.fallback_board; }  // never reached
_board = board;
```

Since `_check_boardtype()` returns `board_M5AtomS3RExt` rather than `board_unknown`, `fallback_board` is silently ignored. When the board is misdetected as AtomS3RExt, the `_speaker_enabled_cb_sticks3` callback — which enables the M5PM1 GPIO3 power amplifier — is never registered, so the PA stays off and nothing comes out.

The fix is a one-line change in `M5Unified.hpp`:

```cpp
// before
if (board == board_t::board_unknown) { board = cfg.fallback_board; }

// after
if ((board == board_t::board_unknown || board == board_t::board_M5AtomS3RExt)
    && cfg.fallback_board != board_t::board_unknown) {
  board = cfg.fallback_board;
}
```

This is a local patch to the library under `.pio/libdeps/` — it will be lost if PlatformIO re-downloads M5Unified. The right long-term fix is a PR upstream.

With this in place, `M5.Speaker.tone(1000, 300)` in `setup()` produces an audible beep on boot, confirming detection succeeded.

## Bug 2: cross-core D-cache coherence

`tone()` works because it generates audio samples internally inside the Speaker task running on core 0. `playRaw()` is different — it takes a pointer to a buffer that your code (on core 1) fills, and the Speaker task (on core 0) reads that buffer asynchronously.

On the ESP32-S3, both cores have separate write-back L1 D-caches. When core 1 writes PCM samples into the buffer via `memcpy`, those writes sit in core 1's cache. The Speaker task on core 0 reads the same memory address, but from core 0's perspective the cache line is cold — it fetches from the backing store (SRAM or PSRAM), which hasn't received core 1's dirty data yet. Core 0 reads zeros.

This affects both PSRAM and internal SRAM. The "allocate from internal SRAM" approach suggested in some ESP32 audio examples doesn't help here because internal SRAM is still accessed through the per-core D-cache.

The fix is to flush core 1's dirty cache lines before handing the buffer to `playRaw()`:

```cpp
#include <esp32s3/rom/cache.h>

static void flushAudio() {
    if (!g_pcmBuf || g_pcmLen == 0) return;
    Cache_WriteBack_Addr((uint32_t)g_pcmBuf, g_pcmLen * sizeof(int16_t));
    M5.Speaker.playRaw(g_pcmBuf, g_pcmLen, AUDIO_RATE, false, 1, 0, true);
    g_pcmLen = 0;
}
```

`Cache_WriteBack_Addr()` is a ROM function that forces all dirty lines in the given address range to be written back to the backing store. After this call, core 0 reads fresh data.

## Bug 3: BLE write truncation at 16kHz

The audio bridge streams PCM to the device as framed BLE writes:

```
0xAA + uint16_le(chunk_size) + raw_int16_pcm_data
```

The firmware accumulates all chunks in a buffer and calls `playRaw()` when it receives the end-of-stream sentinel (`0xAA 0x00 0x00`).

At 8kHz, the chunk size was 176 bytes → total frame 179 bytes. This fit comfortably within the BLE ATT MTU. At 16kHz, the naive scaling doubles the chunk size to 352 bytes → total frame 355 bytes.

BLE ATT Write Without Response is capped at `MTU - 3` bytes by the spec. On macOS, the negotiated MTU is typically 185, giving a maximum payload of 182 bytes. CoreBluetooth silently truncates any write larger than this — no error, no exception, just 182 bytes delivered instead of 355.

The firmware state machine reads the size field (352), waits for 352 bytes, but only receives 179 before the next frame's `0xAA` byte starts arriving. Everything that follows is misinterpreted. The end-of-stream sentinel never arrives in a recognisable form, so `flushAudio()` never fires.

The fix is to cap the chunk size to fit within any negotiated MTU:

```python
# BLE ATT Write Without Response payload = MTU-3 = 182 bytes.
# Frame overhead = 3 bytes (0xAA + uint16_le), leaving 179 bytes for audio.
# 176 = largest even number safely under that limit (even required for int16_t pairs).
_ATT_MAX_AUDIO = 176
AUDIO_PAYLOAD = min(AUDIO_RATE * 22 // 1000, _ATT_MAX_AUDIO)
```

At 16kHz this yields 176-byte chunks (88 samples, ~5.5ms per frame) instead of 352. The device receives clean, complete frames and `playRaw()` fires with the full audio once the stream ends.

## What this is for

Pepper is an AI pet running a Claude brain loop. The M5StickS3 is the hardware face: Pip-Boy style display, BLE connection to a macOS bridge that handles TTS and forwards simulator events. The bridge generates speech audio via macOS `say` (Meijia voice at 16kHz), streams it over BLE, and the S3 plays it through the ES8311 speaker. With these three fixes in place, the full pipeline works — brain decides to speak, bridge synthesises audio, device plays it.
