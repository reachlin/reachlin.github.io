---
title: ai pet — improving audio quality over BLE and giving it eyes
---

Two problems with the AI pet this session: the voice coming out of the M5Stack speaker sounded terrible, and the pet was receiving camera frames every tick but completely ignoring them. Both fixed.

## Why the audio sounded bad

The pet uses a Hat SPK2 speaker (MAX98357 I2S DAC) stacked on a M5StickC Plus. Audio travels from the Mac over BLE Nordic UART Service (NUS) as raw PCM frames, then the ESP32 writes it to the I2S DMA buffer.

The original pipeline was:

```
macOS say → AIFF → afconvert -d UI8@8000 → uint8 PCM over BLE → firmware expands to int16 → I2S
```

Two problems stacked here:
1. **Double quantisation noise** — afconvert was going straight from high-quality AIFF to 8-bit. Every sample gets rounded to one of 256 levels (~48dB dynamic range). Then the bridge boosted volume 3×, which amplified the quantisation noise floor along with the signal.
2. **8kHz Nyquist at 4kHz** — cuts off consonants like "s", "t", "f" which live above 4kHz. Speech becomes intelligible but muffled.

The fix for the quantisation noise was to stop doing the 8→16 bit round-trip entirely. Keep 16-bit throughout:

```
macOS say → AIFF → afconvert -d LEI16@8000 -q 127 → int16_le over BLE → firmware writes directly to I2S
```

The old bridge was packing samples into uint8, then the firmware was expanding them back:

```python
# before — packing to 8-bit (lossy)
v = int(s * VOLUME_BOOST / 256) + 128
out[i] = max(0, min(255, v))
```

```python
# after — keep 16-bit, boost in place
v = int(s * VOLUME_BOOST)
samples[i] = max(-32768, min(32767, v))
return samples.tobytes()
```

On the firmware side, `writeAudioChunk` used to expand every byte:

```cpp
// before
for (uint16_t i = 0; i < n; i++)
    pcm16[i] = (int16_t)((src[i] - 128) * 256);
i2s_write(I2S_PORT, pcm16, n * 2, &written, portMAX_DELAY);
```

```cpp
// after — raw int16_le bytes go straight to I2S
i2s_write(I2S_PORT, src, n, &written, portMAX_DELAY);
```

## The 16kHz experiment that made it worse

The obvious next step was to try 16kHz — double the sample rate, double the frequency range, capture those consonants. Tried it. Audio immediately got worse, not better.

The cause: 16kHz 16-bit mono requires 32KB/s sustained throughput. BLE `write_gatt_char` with `response=False` (write without response) gives no acknowledgement and no backpressure. If the BLE stack can't keep up, frames are dropped silently. The firmware never knows — it just plays whatever arrived and skips the gaps.

At 32KB/s we were consistently dropping frames. The resulting audio was garbled noise with random pops.

The practical ceiling for write-without-response on the ESP32's BLE stack, without negotiating a shorter connection interval, is around 16KB/s. 8kHz 16-bit sits at exactly that level and is stable. 16kHz is out without deeper BLE work (connection interval negotiation, flow control).

**The actual audio bandwidth is half the bottleneck, not the sample rate.**

## Multilingual voice

Added a `language` field to `config/identity.yaml`. The brain reads it and injects a language rule into the system prompt:

```yaml
language: Chinese
```

```python
lang = data.get("language", "English")
lang_rule = f"\nLANGUAGE: Always respond and speak() in {lang} only.\n" if lang.lower() != "english" else ""
```

On the bridge side, `SAY_VOICE` controls which macOS voice is used. macOS ships with a good set of voices: `Tingting` and `Meijia` for Mandarin, `Thomas`/`Eddy (French (France))` for French, and so on. The voice and the brain's output language need to match — a Chinese voice trying to pronounce English phonetically sounds worse than either alone.

For OpenAI TTS (`tts-1-hd`), no voice change is needed at all — it detects the language from the input text automatically.

## Pepper was ignoring the camera

The brain loop fetches a webcam frame from the browser every tick and includes it in the multimodal message to the model (base64 JPEG for Claude, image URL for OpenAI). But the system prompt never mentioned the camera existed:

```
You have tools: move, speak, set_mood, remember, recall, stock_price, search, browse.
```

No mention of vision. The model received the image, had no instruction to use it, and mostly ignored it in favour of deciding which direction to move next.

The fix was a single sentence in the system prompt:

```python
"You have a camera: each tick includes a live image of your surroundings. "
"Notice what you see — people, objects, expressions, activity — and let it shape what you say and feel."
```

And the per-tick message became:

```
Camera frame attached — look at it and react to what you see.
```

Within one tick the pet started commenting on what it could see — wall art, whether someone was present, what they were doing. The camera had been wired up correctly all along; the model just needed to be told to pay attention to it.

## Lessons

- **BLE write-without-response is fire-and-forget** — there's no congestion signal. If you exceed the stack's sustained throughput, frames vanish silently. Don't assume "it connected, therefore it's keeping up."
- **Bit depth matters more than sample rate for speech quality** — going from 8-bit to 16-bit at the same 8kHz eliminated the noise floor more noticeably than the sample rate change would have.
- **Multimodal models don't use attached images unless prompted to** — sending the image is necessary but not sufficient. The system prompt needs to explicitly tell the model that visual input exists and that it should act on it.
