# Gemini Audio and Files API Limits

Verified against Google's official Gemini API documentation on 2026-11-09. The runtime model is required from `GEMINI_MODEL`; the code has no model-name fallback. `server/.env` was not read.

## Audio formats and MIME types

The [Audio understanding guide](https://ai.google.dev/gemini-api/docs/audio) lists these MIME types:

| Format | Documented MIME type |
| --- | --- |
| WAV | `audio/wav` |
| MP3 | `audio/mp3` |
| AIFF | `audio/aiff` |
| AAC | `audio/aac` |
| OGG | `audio/ogg` |
| FLAC | `audio/flac` |
| MPEG | `audio/mpeg` |
| M4A | `audio/m4a` |
| L16 | `audio/l16` |
| Opus | `audio/opus` |
| ALAW | `audio/alaw` |
| MULAW | `audio/mulaw` |
| WebM | `audio/webm` |

Therefore M4A is listed in the current docs. This project deliberately accepts only `.mp3` and `.wav` per its Phase 6 product rule; Gemini's broader support does not change the application's allow-list. Google examples also use `audio/mpeg` for MP3 in the Files API.

## Audio length and request size

Google lists a maximum of **9.5 hours of audio per prompt**. Audio is represented at 32 tokens per second (1,920 tokens per minute), so the model input-token limit and other prompt material can become practical constraints before that duration.

The Audio guide says to use the Files API for audio files larger than **20 MB** and says inline audio requests are limited to **20 MB total**, including prompts and all files. The generic [File input methods comparison](https://ai.google.dev/gemini-api/docs/file-input-methods) currently states a 100 MB inline request limit (50 MB for PDFs). These pages differ; this project follows the audio-specific, more conservative 20 MB rule. Phase 6 uses the Files API for every audio upload regardless of size, so it does not depend on this threshold.

The Files API documentation gives a maximum of **2 GB per file**, **20 GB per project**, and a **48-hour** lifetime for uploaded files. Files may be deleted earlier with `ai.files.delete({ name: file.name })`; Phase 6 attempts that in a `finally` block. File state can be `PROCESSING`, `ACTIVE`, or `FAILED`; only an `ACTIVE` file is ready for inference. The service waits for readiness, subject to its transcription timeout.

## Model output and free-tier quotas

The configured runtime model comes only from `GEMINI_MODEL` (no default is set in code). Both [Gemini 3.5 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) and [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) list a maximum output of **65,536 tokens**. The transcription request uses that shared limit and `thinkingLevel: 'minimal'`, the lowest level supported by both models. Gemini documents `thinkingLevel` for Gemini 3.x; `thinkingBudget` is the legacy control used by Gemini 2.5 and should not be mixed with `thinkingLevel`. `minimal` minimizes thinking but does not guarantee it is fully disabled. `MAX_TOKENS` is treated as truncation.

Google's [rate limits page](https://ai.google.dev/gemini-api/docs/rate-limits) says rate limits depend on model, usage tier, project, and account status; the active values are shown in Google AI Studio. I could not confirm the exact free-tier RPM, TPM, or RPD for this project's Google Cloud project, and did not access AI Studio. Treat those quotas as unconfirmed and check the project's AI Studio rate-limit dashboard. The model page and pricing page do not establish the project's account-specific quota.

## Application upload limit proposal

Recommend `MAX_AUDIO_MB=100` as a starting application limit because uncompressed stereo WAV can use roughly 10 MB per minute at CD-quality PCM, making the existing 25 MB default restrictive for a 2–5 minute recording. This remains below the Files API per-file maximum while limiting local upload bandwidth and temporary disk use. It is a product/configuration recommendation, not a Google API limit; operators should adjust it for their expected WAV encoding and hosting capacity. No `.env` value was changed.

## Documentation used

- [Audio understanding](https://ai.google.dev/gemini-api/docs/audio)
- [Files API](https://ai.google.dev/gemini-api/docs/files)
- [File input methods](https://ai.google.dev/gemini-api/docs/file-input-methods)
- [Gemini 3.5 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash)
- [Gemini 3.5 Flash-Lite model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [GenerateContent API reference](https://ai.google.dev/api/generate-content)
- [Thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [Gemini 3.5 Flash migration and parameter guide](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5)
