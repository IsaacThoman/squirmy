# Audio engine

This is the design for Phase 1 of the playback overhaul. The [implementation plan](#implementation-plan) splits the work into pull requests, and the [roadmap](./roadmap.md#_10-playback-core) tracks their status.

This page replaces the playback and streaming core on every client. Today's engines and transcodes are described in [Architecture, "Playback and streaming"](./architecture.md#playback-and-streaming) and in the Clients section there. Every claim below about today's code was checked against the code; paths are relative to the repository root.

## Decisions

| Area | Decision | Instead of |
| --- | --- | --- |
| iOS and tvOS output | A native engine in a local Expo module. It decodes with Apple's decoders, mixes and processes PCM itself, and plays it through one `AVSampleBufferAudioRenderer` on an `AVSampleBufferRenderSynchronizer`, with the long-form route-sharing policy. | `expo-audio` (one `AVPlayer` per track), `AVQueuePlayer`, `AVAudioEngine` |
| iOS bytes | One sparse cache file per stream, filled by a sequential download plus Range requests for holes. The same file is the streaming cache entry and, once complete, the download. | Fetching the playing stream a second time |
| iOS decoding | `AudioFile`/`ExtAudioFile` over the cache file for originals; `AudioFileStream` + `AudioConverter` for server transcodes, trimmed with numbers the server sends. No FFmpeg or libopus on the device. | On-device FFmpeg |
| Server delivery | Originals as they are, with Range. Transcodes for the new engines in fragmented MP4: FLAC (lossless), Opus (lossy, iOS), AAC (lossy, the web and clients without Opus). The playback descriptor carries the exact priming and length. Live transcodes seek by restarting at a time offset. | HLS, length estimates, edit lists |
| Transcode scheduling | Priorities (`play` > `next` > `cache` > `download`), preemption, and cancelling an abandoned encode. | First come, first served; abandoned encodes run to the end |
| Web | One `<audio>` element fed through Media Source Extensions with FLAC or AAC in fragmented MP4, so consecutive tracks share one timeline (sample-exact in Chromium, measured), routed through Web Audio for gain, EQ and a limiter. A second element only during a crossfade. Today's engine stays as the fallback. | Two elements handed over with `setTimeout`; Web Audio decode-ahead; WebCodecs |
| Normalization | Boost allowed everywhere, a true-peak limiter after it, a selectable target, and an estimated gain for tracks not yet measured. | Attenuation only on iOS; a `1/peak` clamp on the web |
| Connect | Queue changes go out as small diffs against a queue version, with the full queue as a checkpoint; clients that do not ask for diffs get the full queue as today. Queue edits can be undone. | The full queue on every track end |
| Android | Media3 ExoPlayer behind the same JavaScript interface, later. | |

## What is wrong today

Each claim of the earlier audit, checked against the code. The measurements are from [Measurements](#measurements).

| Claim | Verdict | Where |
| --- | --- | --- |
| iOS is not gapless: it waits for `didJustFinish` over the bridge, releases the old player and plays the next. | **True.** `finish()` runs from the JavaScript status listener, releases the finished player and only then calls `play()` on the preloaded one. `expo-audio` posts `didJustFinish` from `AVPlayerItemDidPlayToEndTime`. Measured: 99 ms (AAC) and 141 ms (FLAC) of silence between two prerolled `AVPlayer`s handed over natively on that notification, before any JavaScript hop. | `apps/mobile/src/player/engine/ExpoAudioEngine.ts:464-490`, `:302-322`; `node_modules/expo-audio/ios/AudioPlayer.swift:470-499` |
| A looping silence keeps the app alive. | **True.** A 2 s `silence.m4a` loops while the engine holds the session or loads. | `ExpoAudioEngine.ts:370-398`; `apps/mobile/src/player/engine/index.ts:11-12`, `:47` |
| Interrupted players are muted to fight auto-resume. | **True.** | `ExpoAudioEngine.ts:105-109`, `:361-368` |
| A stuck player is paused and played again after 2, 4 and 8 s. | **True.** | `ExpoAudioEngine.ts:11`, `:436-446` |
| AirPlay external playback is disabled. | **True,** for a reason that stays valid for `AVPlayer`: the receiver would fetch the URL itself and cannot fetch the local silence. | `apps/mobile/src/player/engine/index.ts:44-53` |
| ReplayGain is attenuation only on iOS. | **True.** The player's volume is the gain, clamped to 1. | `apps/mobile/src/playback.tsx:132`; `packages/client-core/src/normalization.ts:34`; `ExpoAudioEngine.ts:530-533` |
| The web clamps the gain by `1/peak` with no limiter. | **True.** | `packages/client-core/src/normalization.ts:33` |
| Unmeasured tracks play at gain 1. | **True.** With every measured track turned down by the -18 LUFS reference (typically 6 to 10 dB for current masters), an unmeasured one is that much louder until the sweep reaches it. | `normalization.ts:25`, `:31`; `apps/server/src/modules/loudness/normalization.ts:6-7` |
| The streaming cache downloads the current track again on Wi-Fi and skips it on cellular. | **True.** | `apps/mobile/src/streamingCache/model.ts:152-163` |
| No EQ, crossfade, limiter or speed. | **True** on every client. | |
| iOS has no Opus, so `data_saver` falls back to `mp3_192`. | **True** for the code: `codecsFor('ios')` leaves Opus out, so the first `data_saver` profile iOS decodes is `mp3_192`. Apple's decoders do play Opus, though: Ogg Opus decoded sample-exactly through `AVAudioFile` on iOS 27 and macOS 27. | `apps/mobile/src/player/session.ts:109-111`; `apps/server/src/modules/streaming/select.ts:8-12` |
| The web is pseudo-gapless through `setTimeout(remaining - 4 ms)`, throttled in background tabs. | **True, with a correction.** The handoff is a timer 4 ms before the computed end. Chrome barely throttles timers in a tab that made sound in the last 30 seconds, Firefox does not throttle a tab with an `AudioContext`, and Safari does not throttle a playing media element, so background throttling is not the main problem. The handoff is: in Chromium, with today's Ogg Opus, the timer never fires before `ended` (the element's duration includes the 312-sample pre-skip, so the timer is due 2.5 ms after the real end), the next element starts from `ended`, and every boundary has 7.5 ms of silence followed by 6.5 ms of the next song missing (measured, 5 of 5 runs). | `apps/web/src/player/engine/web-engine.ts:25-34`, `:395-418` |
| Web gain changes have no ramp. | **True.** `setValueAtTime` jumps, which clicks mid-song. | `web-engine.ts:380-383` |
| No lossless transcode profile, so ALAC on Chrome or DSD, WavPack and APE at `original` become `aac_256`. | **True.** Every profile is lossy, and `chooseProfile` falls back to the first lossy profile the client decodes. | `apps/server/src/modules/streaming/profiles.ts:31-48`; `select.ts:24-36` |
| `aac_256` is raw ADTS and MP3 uses `-write_xing 0`, destroying gapless information and seek tables. | **Partly true.** ADTS has no place for priming or length, so `aac_256` streams carry 1,024 samples of priming plus padding: a 24.2 ms gap per boundary, measured on the server's own output. MP3 has no LAME tag: 38.7 ms per boundary. But `-write_xing 0` changes nothing: ffmpeg writes the Xing frame only to seekable output, and the output is a pipe (the same bytes come out either way). The MP3 profiles are constant bitrate, so seeking by byte offset is exact without a seek table. `opus_128` (Ogg) is already gapless: 1 sample, from resampling. | `profiles.ts:25-29`, `:33-47` |
| Live transcodes answer `Accept-Ranges: none` with no `Content-Length`. | **True,** and the cached copy answers Range afterwards. | `apps/server/src/modules/streaming/transcode.ts:353-369` |
| Abandoned ffmpeg jobs are not cancelled on rapid skips. | **True, and worse than stated.** A client that leaves only closes its reader; the encoder runs to the end. Encoder slots (half the cores, at least two) are taken first come, first served, so after a few quick skips the song the user wants waits behind encodes nobody listens to. Subsonic's live encodes are killed when the client leaves; the cached profiles are not. | `transcode.ts:216-221`, `:140-167`; `apps/server/src/modules/subsonic/transcode.ts:108-120` |
| Every queue edit and track end rebroadcasts the whole queue. | **True.** `commit` bumps `queueVersion` whenever any of the five queue lists changed, and `broadcast` then sends all of them. A track end always changes `queue`, `history` and `playedInCycle`. A 10,000-entry queue is 1.7 to 2.9 MB of JSON, 0.3 to 0.56 MB deflated, per socket, per track. | `apps/server/src/modules/sessions/service.ts:207-209`, `:243-248`; `packages/client-core/src/session/reducer.ts:87-93`, `:273`, `:502-503` |

Found besides the audit:

- **AAC in fragmented MP4 from ffmpeg loses the priming.** ffmpeg writes no edit list into a fragmented MP4's `moov`, and Apple's `AVAudioFile` then assumes its default priming of 2,112 samples, cutting 1,088 real samples from the start. An edit list injected afterwards is honoured by ffmpeg but ignored by Apple's file reader. Any MP4 delivery has to carry the priming outside the container for Apple clients.
- **Chromium drops the first 312 real samples of every Ogg Opus track in an `<audio>` element** (the length of the pre-skip, compared with ffmpeg's decode, which applies it once). In Media Source Extensions it uses an MP4 edit list but not the container's duration of the last packet, so ffmpeg's AAC in fragmented MP4 (last packet stored as 981 of 1,024 samples) keeps 43 samples of padding at the end. And one Opus decoder carried across two separate encodes produces 17 ms of wrong audio after the boundary (Chromium does not reset it, and libopus offline does the same), so Opus does not suit a single MSE timeline.
- **When an `AVSampleBufferAudioRenderer` runs dry, its synchronizer's clock keeps going** (with 1.0 s enqueued, the timebase read 2.44 s after 2.5 s). An engine on it has to track how far ahead it has enqueued and stop the clock itself on an underrun, or it will skip audio after a stall.
- **`flush(fromSourceTime:)` only works about a second ahead of the playhead.** It was refused at every distance up to 500 ms and accepted from 1,000 ms. Settings that change the sound, like EQ, therefore apply by rendering only a short way ahead, not by flushing.
- **Apple's file reader needs the end of some files before it plays.** MP4s with the index at the end (ffmpeg's default; ALAC rips often are), MP3s (probably for a trailing ID3v1 tag) and Ogg (it looks for the last page) are read at the end on open. Over a sequential download that means waiting for the whole file; with Range requests for the missing part it costs one or two extra requests (about 0.1 s).

## Measurements

The spikes were throwaway programs, not in the repository. The method is repeatable from this description and becomes the acceptance tests in the [Implementation plan](#implementation-plan).

**Signal.** A 6 s quiet stereo chirp (0.03 full scale, different sweeps per channel, so a cross-correlation has one peak), cut into two halves at frame 133,077 of 221,610 at 44.1 kHz. Neither half is a multiple of any codec's frame size. Each half was encoded separately with exactly the server's ffmpeg arguments, written to a pipe as the server does. Each pair was decoded, and the boundary located by cross-correlating each half against the original around its expected start and end. The gap is the number of samples the decoded halves add (or remove) at the boundary: 0 is gapless.

**Server formats** (ffmpeg 9.0.2 encoding; decoded with ffmpeg, and with `AVAudioFile` on macOS 27.0.1 and the iOS 27.0 simulator, which agreed in every case):

| Delivery | ffmpeg decode | Apple `AVAudioFile` | Apple `AudioFileStream` + `AudioConverter` |
| --- | --- | --- | --- |
| Original FLAC (control) | 0 | 0 | last partial frame withheld (no end-of-stream call) |
| `aac_256` today (ADTS) | +1,067 (+24.2 ms) | +1,067 | +1,067 |
| `mp3_320` today (CBR, no LAME tag) | +1,707 (+38.7 ms) | +1,707 | +1,178 |
| `opus_128` today (Ogg) | +1 (resampling) | +1 | not trimmed: needs the numbers from the server |
| FLAC piped (STREAMINFO says 0 samples) | 0 | 0, reading to the end (`length` says 0) | last partial frame withheld |
| FLAC in fragmented MP4 | 0 | 0 | **0** |
| Opus in fragmented MP4 (pre-skip in `dOps`, no edit list) | +763 (+15.9 ms, end not trimmed) | cannot open | not trimmed: needs the numbers from the server |
| AAC in fragmented MP4, edit list injected | +43 (+1.0 ms) | -1,045 (-23.7 ms, 2,112 assumed) | +1,067; exact with the server's numbers |
| AAC in MP4 with the index first (ffmpeg file output) | 0 | 0 | 0 (packet table 1024/43) |
| Opus in WebM | +1 | cannot open | cannot open |

The bytes served by a running server (a throwaway test against the real `/stream` route with its own Postgres) matched these exactly, live and cached alike: `original` 0, `aac_256` +1,067, `opus_128` +1, `mp3_320` +1,707.

**Seeking a live transcode by restarting ffmpeg at an offset** (`-ss 1.2345` before `-i`): the first decoded sample was exactly the one at 1.2345 s for FLAC and Opus, and 1,024 samples early (the priming) for ADTS AAC.

**iOS output path** (`AVSampleBufferAudioRenderer` with `AVSampleBufferRenderSynchronizer`, float32 stereo PCM in 4,096-frame buffers; the same on macOS 27.0.1 and the iOS 27.0 simulator):

| Test | Result |
| --- | --- |
| The two FLAC halves decoded by Apple and enqueued back to back with contiguous timestamps | The enqueued stream equals the uncut original (largest difference 1.2e-7, float rounding). At the boundary at least 1.2 s was enqueued ahead of the playhead, so the renderer never ran dry. No flush or reconfiguration events. |
| The two Ogg Opus halves (Apple decoder) | Boundary within 1 sample. |
| 44.1 kHz track followed by a 48 kHz track, not resampled | Accepted with no events and no clock discontinuity. |
| Clock with nothing left to play | Keeps running (see above). |
| Our own feed loop holding the lead at 50, 100, 250 or 500 ms | Played through with the lead never reaching zero and no events. |
| `flush(fromSourceTime:)` at playhead + 20 ms to + 500 ms | Refused. At + 1,000 and + 1,500 ms (with 2 s enqueued): accepted. |
| Rate 1.5 with the time-domain, spectral and varispeed algorithms | All played 3.02 s of audio in 2.1 s. |
| Today's approach for comparison: two prerolled `AVPlayer`s, the second started from `AVPlayerItemDidPlayToEndTime` | 98.7 ms (AAC in MP4) and 141.3 ms (FLAC) between the first track's end and the second's first sample, on every run, before any JavaScript round trip. |

The simulator plays through the Mac's audio hardware and nothing here captured the analog output (there is no loopback device on the machine). Gaplessness is shown at the renderer's input: a continuous, sample-exact stream, with the lead above zero throughout. Device verification steps are in each pull request below.

**Progressive reads** (`AudioFileOpenWithCallbacks` + `ExtAudioFileWrapAudioFileID` over a 60 s file arriving at 1 MB/s; time to the first 4,096 decoded frames; the same on macOS and the iOS simulator). Each Range request was simulated as 100 ms, and the simulation also sent reads just past the download through that path, which a real cache would simply wait for; the index-first MP4's 0.12 s is that artefact:

| File | Sequential download only | With Range requests for missing parts (+100 ms each) |
| --- | --- | --- |
| FLAC (also piped, with no length) | 0.07 s (3 % downloaded) | 0.07 s |
| AAC in MP4, index first | 0.02 s | 0.12 s |
| AAC in MP4, index last | 1.66 s (all of it) | 0.12 s (2 requests) |
| ALAC in MP4, index last | 2.64 s (all of it) | 0.12 s (2 requests) |
| MP3 CBR and VBR | whole file | 0.11 to 0.12 s (1 request) |
| Ogg Opus | whole file | 0.75 s (7 requests) |

[The web numbers](#web-measurements) are in the web section.

## iOS and tvOS engine

### Output API: why the sample-buffer renderer

| | `AVPlayer` / `AVQueuePlayer` | `AVAudioEngine` | `AVSampleBufferAudioRenderer` + synchronizer |
| --- | --- | --- | --- |
| Gapless | `AVQueuePlayer` relies on each file's own metadata (not measured here); separate `AVPlayer`s are not gapless (measured above) | Exact: we schedule PCM | Exact: we enqueue PCM with contiguous timestamps (measured) |
| Crossfade | Two players; on AirPlay 2 only one player is heard ([Apple engineer](https://developer.apple.com/forums/thread/105877)) | Mixer | Mixed by us into one stream |
| DSP | `MTAudioProcessingTap`, not on AirPlay external playback | Built in, changes heard at once | Ours, rendered ahead; heard after the lead (0.4 s locally) |
| AirPlay 2 buffered (multi-room, receiver buffers minutes) | Yes | No: reported to take the real-time path, about 2 s of latency, slow controls ([AudioKit #1410](https://github.com/AudioKit/AudioKit/issues/1410), [`outputLatency`](https://developer.apple.com/documentation/avfaudio/avaudiosession/outputlatency)) | Yes ([WWDC17 509](https://developer.apple.com/videos/play/wwdc2017/509/), [WWDC23 10238](https://developer.apple.com/videos/play/wwdc2023/10238/)) |
| Our bytes (cache in one pass) | Only through `AVAssetResourceLoader` | Yes | Yes |
| tvOS | Yes | Yes | Yes (tvOS 11+) |
| Real-time code of ours | None | Render callbacks if we go beyond Apple's units | None: we enqueue from an ordinary queue |

`AVAudioEngine` is what most third-party players use (SFBAudioEngine, AudioStreaming, Amperfy), and it is the easiest way to get DSP. It loses the buffered AirPlay 2 path, which is what makes AirPlay reliable on ordinary Wi-Fi and lets a phone play to several speakers in sync. Plexamp plays to AirPlay through the real-time path; Plex staff described their buffered attempt as flaky, with overlapping tracks, EQ and queue edits forcing the receiver's buffer to be flushed and rendered again, and capped how far ahead they rendered at about a dozen seconds ([Plex forum](https://forums.plex.tv/t/plexamp-airplay-two-great-tastes-that-are-horrible-together/835583)). We take the buffered path and design for that cost: render only a short way ahead locally, a bounded way ahead on AirPlay, and replace queued audio only where it is cheap. Spotify, also a custom engine, had not shipped AirPlay 2 by the last report found ([MacRumors, 2023](https://www.macrumors.com/2023/04/02/spotify-downplays-homepod-support/)).

Trade-off accepted: on the buffered path the receiver reportedly gets AAC, not lossless (user testing of Tidal and Qobuz, [Amperfy #348](https://github.com/BLeeEZ/amperfy/issues/348)). Local, wired, USB and Bluetooth output are unaffected.

### Pipeline

```
 URLSession ──► ByteCache (sparse file + range map) ──► Decoder ──► PCM ring per item
                    ▲  Range for holes                    │  FileDecoder: AudioFile/ExtAudioFile (originals)
                    │                                     │  StreamDecoder: AudioFileStream + AudioConverter (transcodes)
                    └── StreamingCache / downloads (JS)   ▼
                                       Timeline: items on one sample clock, gapless or crossfaded
                                                          ▼
                              DSP: item gain → EQ → preamp → true-peak limiter (float32, engine rate)
                                                          ▼
                    Feed loop (holds the lead) ──► AVSampleBufferAudioRenderer ◄── AVSampleBufferRenderSynchronizer
                                                                                       (clock, rate, boundary observers)
```

- **One process-wide engine** (`SquirmyAudioEngine.shared`), created natively on first use and owned by no view or JavaScript object. It outlives a JavaScript reload and is the same object whichever scene drives it, which is what CarPlay needs (see [CarPlay](#carplay)).
- **Queues.** A decode queue (serial, user-initiated QoS) owns the decoders and may block on the byte cache. A feed queue (serial, user-interactive QoS) owns the timeline, DSP and renderer and never blocks on input/output: it only takes from the per-item PCM rings. Events go to JavaScript on the main queue. Nothing of ours runs on a real-time audio thread, because the renderer pulls from its own buffer.
- **Engine rate.** The timeline runs at the output's sample rate (`AVAudioSession.sampleRate`, 48 kHz on current iPhones), so the system does not resample again. Each item is converted with `AVAudioConverter` at mastering quality when its rate differs. When the route changes the rate (`OutputConfigurationDidChange`), the engine re-renders from the playhead at the new rate. Channels: mono plays on both sides; more than two channels are downmixed to stereo (spatial and multichannel output on tvOS can come later through `allowedAudioSpatializationFormats`).
- **Lead.** The feed loop (a 20 ms timer on the feed queue, enqueuing while `isReadyForMoreMediaData`) keeps 0.4 s rendered ahead on local, wired, USB and Bluetooth routes, and 10 s on AirPlay. Rendering is cheap (estimated at tens of milliseconds of CPU for 10 s of stereo through a 10-band EQ and an oversampled limiter), so the AirPlay lead costs memory (10 s is under 4 MB) more than CPU; M8 measures it. The decoders keep 3 s (local) or 12 s (AirPlay) of PCM decoded beyond the lead.
- **Underruns.** The renderer's clock does not stop when it runs dry, so the engine stops it: when the lead falls under 60 ms with the next PCM not decoded (the network stalled), the synchronizer's rate goes to 0 at the current time and the state is `buffering`; at 1 s decoded ahead, or the item fully downloaded, it resumes at the same time.
- **Changing what is already queued.** Locally, nothing needs flushing: new settings are heard after at most the 0.4 s lead. On AirPlay, a queue edit that changes the next item, an EQ change and a crossfade setting change call `flush(fromSourceTime: playhead + 1.5 s)` and re-render from there; if it is refused, `flush()` and re-render from the playhead (a short gap, acceptable for an edit). Seeks always `flush()` and re-render.
- **Automatic flushes** (`WasFlushedAutomatically`, after route changes and rate changes): re-render from the flush time out of a history ring of decoded PCM (2 s locally, 12 s on AirPlay), so the decoders do not have to seek back.

### Gapless

The timeline places each item's first real sample immediately after the previous item's last real sample. "Real" is decided by the decoder:

- **Originals** go through `FileDecoder` (`AudioFileOpenWithCallbacks` + `ExtAudioFileWrapAudioFileID` over the byte cache). Apple applies the file's own gapless information: MP4 edit lists and `iTunSMPB`, the MP3 LAME tag, Opus pre-skip and end trimming in Ogg, FLAC's exact frame counts. Measured exact for FLAC, AAC in MP4 and Ogg Opus. Read with a loop to end of stream rather than trusting `length`, since a piped FLAC reports 0.
- **Which decoder** depends only on the delivery: originals and downloads go through `FileDecoder`, every server transcode (live or cached) through `StreamDecoder`, so a format never alternates between the two. Before the fragmented MP4 profiles exist, today's transcodes go through `StreamDecoder` with today's gaps (ADTS and MP3 carry no numbers; Opus pre-skip is read from the Ogg header).
- **Transcodes** from the server go through `StreamDecoder` (`AudioFileStream` + `AudioConverter`), which needs no file length and so plays a transcode that is still being encoded. It trims with the descriptor's `gapless` numbers (see [Exact lengths](#exact-lengths-and-priming)): `primingFrames` from the start and everything after `frames`. Measured exact for FLAC in fragmented MP4 and, with the server's numbers, for Opus and AAC. The trim at the end is applied only when it is less than one frame of the codec (1,024 samples for AAC, 960 for Opus), so a wrong number cannot cut a song short.

Each item has its own decoder and `AudioConverter`, so no codec state carries from one track into the next (one Opus decoder carried across two encodes spoils the first 17 ms of the second, measured in Chromium and with libopus).

A song chosen on another device, or one the user skips to, is not gapless by definition: it starts from a 5 ms fade-in, and the one it replaces ends in a 10 ms fade-out, so neither clicks.

### Crossfade

- **Setting:** off, or 2 to 12 s (Off, 2, 3, 4, 5, 6, 8, 10 or 12), per device. Off by default. A change applies from the next crossfade that is not queued yet.
- **Never inside an album.** When the next entry is the next track of the same album in album order (the session's context is that album and shuffle is off, the same test `gainFor` uses for album gain, and the entry was not slotted in with Play next), the transition is gapless whatever the setting. `SessionClient` says so on the preload (`EnginePreload.albumRun`). Repeat all wrapping from an album's last track to its first counts as in order, so it is gapless too.
- **Shape:** equal power (sine and cosine) over the whole duration, both items at their own normalization gain; measured constant within 0.0002 dB over a 4 s fade of two tones. The mix always goes through the limiter, since two songs can sum over the ceiling where neither does alone. A user skip uses the 5/10 ms de-click fades instead.
- **Length.** At most half of either entry, so a short song is not all fade. The loaded entry's end has to be known when its fade begins, so while a crossfade is set its decoder runs the fade's length further ahead. A preload that arrives late, or is not decoded in time, gets what is left of the outgoing entry (gapless under 0.1 s).
- **Engine contract.** `ended` for the outgoing entry is emitted when the incoming entry's first sample plays, which with crossfade is up to the fade length before the outgoing one ends, and `getStatus()` from then on reports the incoming entry. Its documentation in `packages/client-core/src/engine.ts` says so; `SessionClient` handles `ended` as before. The outgoing entry's listened time is short by the fade, which the session's play accounting already tolerates (a play counts as complete after half the track).
- **Skips, seeks and edits.** A load (a skip) or a seek during a fade drops the outgoing entry. Seeking back before a fade crossfades again when it comes; seeking into the last seconds starts a shorter one at once. A preload replaced before its fade is heard is crossfaded into instead. An automatic flush inside a fade renders it again from there, both entries where they were (tested bit for bit).
- **Sleep timer.** The timer's fade has to turn both entries down, but `setGain` reaches only the loaded one. An engine with `setFade` (the native one) gets the fade on its own and applies it over everything it plays, ramped over 250 ms; `SessionClient` then leaves it out of the gains. End of song and end of queue preload nothing, so they never crossfade into what would follow.
- On AirPlay the fade is rendered like everything else, into the one stream: two players cannot both be heard there.

### Normalization

- **Gain.** The descriptor's gains bring a track to -18 LUFS. The engine applies `gain + (target + 18)` dB, where the target is the user's choice: -14 (loud, like Spotify's normal level), -16, -18 (default, ReplayGain 2.0) or -23 (quiet). Boost is allowed (`canBoost: true`).
- **Limiter.** A true-peak limiter at the end of the chain: 4× oversampled peak detection, 1.5 ms lookahead, release between 50 and 150 ms depending on how much it is reducing, ceiling -1 dBTP. It is idle (bit-transparent) whenever the gained signal stays under the ceiling, which is nearly every track that is turned down. The lookahead reads the frames the feed loop queues next instead of delaying the output, so the limiter adds no latency and leaves the clock and gapless boundaries alone; the gain a peak needs is held for 10 ms, so the peaks of a low note do not make it ripple. An entry at unity gain (normalization off) does not go through it. With a limiter, `gainFor` stops clamping the gain to `1/peak`; without one (the web until W3, the classic iOS engine, or a later setting for purists), the clamp stays, as today, and an `estimated` gain is not boosted, since its peak is unknown.
- **Unmeasured tracks.** When a file has no measurement and no tags, the server sends the median track gain of the library, marked `estimated: true`, instead of nothing, and queues that file's loudness measurement at high priority when it is played. The next play has the real value.
- **Mode.** `off`, `track`, `album` and `auto` keep their meaning (`packages/client-core/src/normalization.ts:13-23`).
- Normalization and EQ gains are applied by the engine before the limiter; the user's volume stays the system volume on iOS (`systemVolume`), so the engine never attenuates for volume.

### Equalizer

- 10 bands (31 Hz to 16 kHz, ±12 dB, peaking biquads from the RBJ cookbook through Accelerate's `vDSP_biquad`), presets, and a preamp that defaults to minus the largest boost so the limiter seldom works. A parametric mode (for headphone correction profiles) can be added later on the same filters.
- **The response is the curve.** Each filter is an octave and a half wide, with the cookbook's correction for the bilinear transform so the 16 kHz band does not narrow near half the sample rate; a curve with every band at +6 dB is then within 5.75 and 6.17 dB from 31 Hz to 16 kHz. Neighbouring bands overlap, so the filters' own gains are solved for (a linear solve with their measured interaction, then a few corrections with the exact response) to put the response at each centre on its band's setting: within 0.001 dB for the presets and for curves whose neighbours differ by up to 12 dB. A curve that swings further from band to band than octave-wide filters can follow is met as closely as filters within ±24 dB allow.
- A change is heard after the lead; the new filters start from the old ones' state and the two outputs are crossfaded over 10 ms, so it does not click. A change that arrives while one is under way follows it once it is over.
- Off, or flat with no preamp, passes the samples untouched; any curve sends every entry through the limiter.
- Stored per device, since it belongs to the headphones or speakers, not to the account. Presets: Off, Bass Boost, Bass Reducer, Treble Boost, Vocal, Late Night (a loudness contour: fuller bass and treble for low volumes) and Custom. Off is the flat curve, so there is no separate Flat.
- tvOS has the presets, without the band editor.

### Speed

- 0.5× to 2×, per device, off (1×) by default. The synchronizer's rate does it, with `audioTimePitchAlgorithm = .spectral` so the pitch stays (all three algorithms worked at 1.5×; spectral is the one meant for music). A rate change makes the renderer flush itself, which the engine handles like any automatic flush.
- Today the session's position is computed as anchor plus elapsed time, which assumes 1×. The session gains an optional `rate` (default 1) that the position arithmetic multiplies by, so other devices show the right position; older clients ignore it and are corrected by `syncPosition` as now.
- Whether AirPlay receivers honour a rate other than 1 is not documented; the speed control is hidden while the route is AirPlay until it is verified on a receiver.

### Bytes, the streaming cache and downloads

- **`ByteCache`.** Each stream is one file in `Caches/streaming/`, written where its bytes belong, with a range map beside it (64 KiB granularity). A sequential `URLSession` download fills it from the start. When the decoder reads a range that is not there and not about to arrive (the index at the end of an MP4, a trailing MP3 tag, the last Ogg page, a seek), the cache fetches that range with its own `Range` request and the read waits for it on the decode queue. Measured: first audio after about 0.12 s for MP4, ALAC and MP3 files whose ends are read first, and 0.75 s for Ogg (seven requests while Apple's reader looks for the last page), against waiting for the whole file without Range requests.
- **One pass.** What plays is what is cached: the second download on Wi-Fi goes away, and so does the rule that skips caching on cellular (`apps/mobile/src/streamingCache/model.ts:152-163`), since those bytes are downloaded either way.
- **Who decides.** JavaScript (`StreamingCache`) keeps deciding what to keep and evict and keeps its index (`streaming-cache.db`). The engine reports a completed file (`onCacheComplete(cacheKey, path, bytes)`) and JavaScript records it. Prefetch of the next entries goes through the same cache (`prefetch(cacheKey, url)`), so an entry that was prefetched plays from its file.
- **Downloads.** A download is a cache file that is kept: when the user downloads a track that is cached completely at the download quality, the file is moved into `Documents/downloads/` instead of fetched again, and a downloaded file plays through the same `FileDecoder`.
- **Live transcodes** have no length and no Range (see [Seeking](#seeking)). They are cached as they arrive and are complete only if they were played or prefetched to the end; a seek past what has arrived restarts the stream at that time, and that file is then not kept.

### Decoders

- Apple's decoders only: AAC (LC and HE), ALAC, FLAC, MP3, Opus, PCM (WAV, AIFF, CAF). Whether Vorbis decodes is probed at runtime.
- **Opus.** Ogg Opus decoded exactly through `AVAudioFile`, and Opus in fragmented MP4 through `AudioFileStream`, on iOS 27. Apple's documentation dates `kAudioFormatOpus` to iOS 11, Opus in MP4 for `AVPlayer` to iOS 17 ([Apple engineer](https://developer.apple.com/forums/thread/759210)) and Ogg Opus in Safari to 18.4. The app's oldest supported iOS (16.4, from the local modules' podspecs) was not available to test, so the engine does not assume: at start it decodes a 0.1 s embedded Opus sample and leaves `opus` out of its `codecs` if that fails, and the server then sends AAC.
- **Everything else** (DSD, WavPack, APE, WMA, Musepack) is transcoded by the server, to FLAC at `original` quality.
- **Rejected: FFmpeg or libopus on the device.** FFmpeg would decode every format and needs no server transcodes, but it adds several megabytes, LGPL obligations for an App Store build (dynamic linking and relinkable objects), a native build in Expo prebuild and CI, and a parser for untrusted files in the app. The server already transcodes, and Apple decodes everything the server sends.

### Audio session, routes and interruptions

- **Category** `.playback`, mode `.default`, policy `.longFormAudio`, and `AVInitialRouteSharingPolicy = LongFormAudio` in `Info.plist` (from the module's config plugin). The long-form policy allows no category options, which matches today's `doNotMix`.
- **No silence file.** While an entry loads (a transcode starting, an on-demand track being fetched, `holdAudioSession`), the engine runs the synchronizer and enqueues digital silence, so the session stays active and iOS keeps the app running; the position stays at the entry's start and the state is `loading`. `silence.m4a`, `holdBackgroundTime` and the pause-and-play retries were workarounds for `AVPlayer` and are deleted with `ExpoAudioEngine`.
- **Interruptions.** On began the engine stops the clock, reports `paused` and calls `onInterrupted`; on ended with `shouldResume` it calls `onResumed`. It never resumes by itself, so nothing needs muting. On iOS and tvOS 27 it uses `didBecomeInactiveNotification` and `resumptionRecommendationNotification`, which replace the interruption notification there.
- **Route changes.** `oldDeviceUnavailable` pauses (headphones unplugged), as now. The system also interrupts long-form sessions on a route disconnect from iOS 17; the default is kept. A route change also sets the lead (AirPlay or not).
- **Media services reset** rebuilds the renderer and synchronizer and resumes at the position.
- **Remote commands and Now Playing** stay in `modules/now-playing` (and with the CarPlay work, see below): buttons become session commands in JavaScript, never engine calls. For accurate elapsed time on the lock screen, the engine posts a `SquirmyAudioClockDidChange` notification with the elapsed time and rate whenever they change discontinuously (play, pause, seek, item change, rate), and `NowPlayingModule` writes it into `MPNowPlayingInfoCenter` without waiting for JavaScript. `MPNowPlayingSession` takes only `AVPlayer`s, so the info center stays the mechanism ([Apple](https://developer.apple.com/documentation/mediaplayer/mpnowplayingsession)).

### CarPlay

Draft pull request #233 starts React Native without a phone window when the car connects first and shares one `PlaybackProvider` between the phone and car scenes (`modules/carplay/plugin/SquirmyCarPlayScenes.swift`, `src/playback.tsx` in that branch). The engine needs nothing more: it is a process singleton outside any scene, CarPlay's Now Playing template reads the same `MPNowPlayingInfoCenter` ([Apple engineer](https://developer.apple.com/forums/thread/717147)), and CarPlay gets enhanced buffering where the car supports it ([WWDC23 10238](https://developer.apple.com/videos/play/wwdc2023/10238/)). Its new `setQueuePosition` and idle `play` target in `NowPlayingModule` are unaffected. Whichever lands second rebases onto the other's `playback.tsx`; the engine work only touches `createPlayerEngine` there.

### tvOS

The same module, built for tvOS 17. Routes are mostly HDMI and the TV's own AirPlay; EQ and speed are hidden until the TV has settings for them.

### JavaScript interface

The engine stays behind `PlayerEngine` (`packages/client-core/src/engine.ts:19-58`), so `SessionClient` and the session logic do not change.

```ts
// apps/mobile/modules/audio-engine/index.ts: the native module, null where it is missing
type Gapless = { sampleRate: number; primingFrames: number; frames: number }
type NativeItem = {
  entryId: string
  url: string            // absolute and signed, or a file:// URL for a download
  startMs: number
  gain: number           // linear; may exceed 1
  cacheKey: string | null
  gapless: Gapless | null        // from the descriptor; FileDecoder reads the file's own instead
  decoder: 'file' | 'stream'     // 'stream' for server transcodes
  albumRun: boolean      // the next item continues this one's album: never crossfade into it
}
interface SquirmyAudio {
  load(item: NativeItem & { autoplay: boolean }): void
  preload(item: NativeItem | null): void
  play(): void; pause(): void; seek(positionMs: number): void; setGain(gain: number): void; stop(): void
  getStatus(): { entryId: string | null; state: EngineState; positionMs: number }   // synchronous, reads the clock
  setEqualizer(curve: { bandsDb: number[]; preampDb: number } | null): void   // the device's setting, from followOutputSettings
  setCrossfade(seconds: number): void            // 0 for none; the device's setting
  setFade(level: number): void                   // the sleep timer's fade, over everything that plays
  probeCodecs(): string[]                          // e.g. ['flac','alac','aac','mp3','wav','aiff','opus']
  prefetch(cacheKey: string, url: string): void; cancelPrefetch(cacheKey: string): void
  addListener(event: 'status' | 'ended' | 'error' | 'cacheComplete' | 'route', listener: (event: any) => void): { remove(): void }
}
```

- `NativeEngine` (`apps/mobile/src/player/engine/NativeEngine.ts`) implements `PlayerEngine` over it, with `canBoost = true`. Events map one to one onto `EngineEvent`; `status` is emitted on the same occasions as today (state or entry changes, a seek landing), and `ended` from a boundary time observer on the synchronizer, so its timing does not depend on JavaScript.
- `EngineLoad` and `EnginePreload` gain an optional `media` object (the descriptor's `gapless` and `transcoded`, and the `cacheKey` the app's `resolvePlayback` adds), which `SessionClient` passes through. `NativeEngine` derives `decoder` from `transcoded`; engines that do not know `media` ignore it.
- `gainFor` gains two options: `limiter` (skip the `1/peak` clamp) and `targetLufs` (default -18).
- The `codecs` sent to `/tracks/:id/playback` come from `probeCodecs()` instead of `codecsFor('ios')`, plus `containers=fmp4`.

### Rollout

- `createPlayerEngine` picks the engine from a device setting, `playbackEngine: 'classic' | 'native'`, shown in Settings → Playback in development and TestFlight builds. `native` falls back to `ExpoAudioEngine` when the module is missing (an old build, Android) or fails to start, and says so in the log.
- Default `classic` until the engine has the [Implementation plan](#implementation-plan)'s first three iOS pull requests and has been verified on a device with AirPlay and CarPlay; then `native` in TestFlight for a release; then `native` everywhere. `ExpoAudioEngine`, `silence.m4a` and the `expo-audio` dependency are removed one release after that.

### Testing

- The engine's core (byte cache, decoders, timeline, DSP, feed loop) is a Swift package inside the module (`apps/mobile/modules/audio-engine/core`) with no Expo dependency. Its tests run with `swift test` on macOS, where the same AVFoundation and AudioToolbox APIs exist (the spikes ran unchanged on macOS and the iOS simulator), as a step in the Apple apps workflow (`.github/workflows/apple.yml`), which already runs on macOS for every pull request.
- Fixtures are generated by a script from `apps/server/src/test/audio.ts`'s tone generator: a continuous quiet tone cut into two halves at a frame that is no codec's multiple, in every delivery format. Tests decode both halves and check the boundary to the sample, as in [Measurements](#measurements).
- The JavaScript side is tested as today, with `FakeEngine` for `SessionClient` and a fake native module for `NativeEngine`, reusing `ExpoAudioEngine.test.ts`'s cases where they still apply.

## Android shape

Not in Phase 1; the shape keeps the JavaScript interface the same.

- **Media3 ExoPlayer** in the same Expo module (`android/`), one player with a playlist of the current and next item. ExoPlayer is gapless for MP3 (LAME tag), MP4 (`iTunSMPB` and single-edit edit lists), Opus (pre-skip) and FLAC, and server transcodes carry the descriptor's numbers for anything it misses.
- **DSP** as `AudioProcessor`s in `DefaultAudioSink` (gain, EQ, limiter) ahead of the built-in `SonicAudioProcessor` for speed. Processors need 16-bit PCM output (float output disables them).
- **Crossfade** is not built into Media3 ([androidx/media#2](https://github.com/androidx/media/issues/2)): two players with volume ramps behind one `ForwardingPlayer`, only for transitions that crossfade.
- **Cache:** one `SimpleCache` with an LRU evictor for streaming and another with `NoOpCacheEvictor` for downloads, read through `CacheDataSource`, so streaming caches in one pass.
- **System integration:** `MediaLibraryService` for the notification, the lock screen and Android Auto.
- **Codecs:** the platform decodes Opus (Android 5+) and FLAC (Android 8.1+); ALAC needs FFmpeg, so Android leaves `alac` out of `codecs` and gets FLAC.

## Server streaming

### Delivery

| Client | Source the client decodes | Source it does not decode, or a lower quality |
| --- | --- | --- |
| Native engines (`containers=fmp4` in the query) | Original, with Range | Fragmented MP4: `flac_mp4` at `original`; `opus_mp4_192` at `high`; `opus_mp4_96` at `data_saver`; `aac_mp4_256` when the client lacks Opus |
| Web MSE engine (`containers=fmp4`, `codecs` without `opus`) | Remuxed into fragmented MP4 without re-encoding (`copy_mp4`); MP3 see below | Fragmented MP4: `flac_mp4` at `original`; `aac_mp4_256` at `high`; `aac_mp4_128` at `data_saver` |
| Older app builds, browsers without MSE, Subsonic clients | Original, with Range | Today's profiles, unchanged: `aac_256` (ADTS), `opus_128` (Ogg), `mp3_320`, `mp3_192` |

- **What MSE takes.** The web engine sends what its `MediaSource.isTypeSupported` accepts, and the server picks within it. MP3 is the awkward case: Chrome and Edge accept MP3 only as an `audio/mpeg` byte stream, not inside MP4, so they get the original bytes in an `audio/mpeg` `SourceBuffer` (switched with `changeType()`); Firefox accepts MP3 inside MP4 (codec `mp3`), so it gets `copy_mp4`; a browser that takes neither gets an AAC transcode. ALAC sources get `flac_mp4`, and Opus sources an AAC transcode, since an Opus decoder carried across tracks is not clean (see [Web measurements](#web-measurements)).
- **Why fragmented MP4.** It is written to a pipe as it is encoded (so the first request streams while the cache fills, as today), it carries FLAC, Opus and AAC alike, MSE takes it for FLAC and AAC in Chrome, Firefox and Safari, and `AudioFileStream` parses it with no file length. Measured exact for FLAC with every decoder, and exact for Opus and AAC with the server's numbers.
- **Rejected: Ogg and native FLAC for the new engines.** Both are gapless with Apple's file reader and ffmpeg, and `opus_128` stays as it is. But MSE accepts neither, Apple's file reader needs the end of an Ogg stream before it plays, and `AudioFileStream` withholds the last frame of a native FLAC stream. One container for both new engines is simpler.
- **Rejected: non-fragmented MP4 written after the encode** (exact everywhere, measured). It cannot be streamed while it is encoded, so the first play of every transcode would wait for the whole encode.
- **Bitrates.** For the iOS engine, Opus at 192 kb/s replaces AAC 256 kb/s as `high` (transparent for nearly all listeners at a quarter less data) and 96 kb/s is `data_saver` (about AAC 128 kb/s quality). The web keeps AAC, at 256 and 128 kb/s. They are constants in `profiles.ts`, easy to tune.
- **Hi-res.** `flac_mp4` keeps the source rate up to 192 kHz and 24 bits; DSD becomes 88.2 or 176.4 kHz PCM.

### Exact lengths and priming

The descriptor gains:

```ts
gapless: z.object({
  sampleRate: z.number().int(),   // of the delivered stream
  primingFrames: z.number().int(),// to drop from the start of the decoded stream
  frames: z.number().int(),       // real frames of the whole track at sampleRate
}).nullable()
```

- **Source length.** `loudness.measure` already decodes each file in full; it also records `media_files.decoded_frames` and `decoded_rate` (ffmpeg applies the source's own gapless information while decoding). For files measured before the migration, the sweep fills them in.
- **Transcode length:** `decoded_frames` at the source rate, or `ceil(decoded_frames × out / in)` when resampled (ffmpeg's resampler rounds up: 133,077 → 144,846 and 88,533 → 96,363 frames from 44.1 to 48 kHz, measured). A test pins this for each rate pair the profiles produce.
- **Priming:** a property of each encoder, kept with the profile: 1,024 for ffmpeg's `aac`, 312 at 48 kHz for `libopus` (it is in the `dOps` box too), 0 for FLAC. A test reads it back from ffmpeg's output so an ffmpeg upgrade that changes it fails.
- **Originals** need no numbers on iOS (Apple reads the file's own), but the web's remux does: `copy_mp4` drops the source's edit list, so the server takes the priming from the source (ffprobe's `skip_samples` side data on the first packet) and sends it with `decoded_frames`.
- **No edit list.** Apple's file reader ignores one in a fragmented MP4 (it assumes 2,112 samples), Chromium's MSE applies one, and Firefox's does not (Mozilla bug 1941303), so an edit list would make the client's arithmetic depend on the browser. The fragmented MP4 carries none, and every engine trims with the descriptor's numbers.
- **The last packet's duration.** A small streaming box rewriter (`streaming/mp4.ts`) sets the stored duration of the final sample in the last `trun` to the codec's full frame (ffmpeg writes the real remainder: 981 of 1,024 for the test's AAC). Chromium computes the append window from stored durations and plays the whole decoded last packet, so without this the padding survives: +43 samples, measured; with it, 0. The field keeps its size, so no offsets move.
- **Native FLAC**, where it is still served (Subsonic `format=flac`, later): the server writes `decoded_frames` into STREAMINFO's total-samples field, which a piped FLAC leaves at 0.

### Seeking

- **Originals and cached transcodes:** HTTP Range, as today.
- **Remuxes** (`copy_mp4`) cannot start on an exact sample, since packets are copied: with `start`, the server starts at least 100 ms early, so MP3's bit reservoir and AAC's overlap are filled, and `X-Squirmy-Start-Frame` says where the stream really starts; the web engine's append window cuts the rest.
- **Live transcodes:** the stream URL takes `start` (milliseconds, outside the signature, like `download`). The server runs ffmpeg with `-ss` before `-i`, which lands on the exact sample for FLAC and Opus (measured); the response carries `X-Squirmy-Start-Frame` (the frame of the track at the delivered rate where the stream's first real sample sits) and the stream has its own priming, given in the descriptor's numbers. Such a stream is never cached; the full encode the track started keeps filling the cache if its priority allows. Subsonic's `timeOffset` already works this way (`apps/server/src/modules/subsonic/transcode.ts:95-108`).
- **Rejected: estimating `Content-Length`.** A wrong length breaks Range-based players. The descriptor's `bytes` stays null until the transcode is cached; an `estimatedBytes` field can feed progress bars.
- **Rejected: HLS.** It would mean a segmenter per stream, playlist and per-segment signed URLs, a different cache layout, and one continuous encode cut into segments so priming does not repeat in each. Its benefits (seeking anywhere, adaptive bitrate) are what `start` and the quality settings already give, and its real advantage, `AVPlayer` and Safari playing it natively, is no use to engines that decode themselves. It is worth revisiting for Chromecast and Sonos, which need it.

### Transcode scheduling

- **Intent.** Stream requests carry `intent`: `play` (the current entry), `next` (the preload), `cache` (streaming cache prefetch) or `download`. The engines send it; requests without it count as `play`, so older clients are unaffected.
- **Priority queue for encoder slots** (`transcode.ts:140-167`): by intent, then arrival. A `play` request that finds every slot taken stops the lowest-priority running encode below `next` (its temporary file is deleted; it starts again when asked again).
- **Abandonment.** When the last reader of an encode goes away: an encode that is `cache` or `download`, or at least half done, runs on and is cached. Any other is stopped after 10 s if no reader returns. Subsonic's live encodes keep being killed at once.
- **Per user**, at most four encodes run at once (today only Subsonic's live encodes are limited, to three); a fifth request stops that user's lowest-priority encode, or is refused with `too_many_live_encodes` when all four are `play`.

### Subsonic

Nothing changes for `/rest`: it keeps the existing profiles, Range, `timeOffset` and `maxBitRate`, and never sees the new profiles. `format=flac` or `raw` for lossless delivery to Subsonic clients can use the native FLAC above later. `apps/server/src/modules/subsonic/media.test.ts` must keep passing unchanged.

## Web engine

### Choice

| | Two elements, timer handoff (today) | Web Audio decode-ahead | WebCodecs + AudioWorklet | **MSE, one element** |
| --- | --- | --- | --- | --- |
| Gapless | No: element start latency and lengths | Exact | Exact | Exact where the browser trims at the append window (see [Web measurements](#web-measurements)) |
| Background tabs | Needs a timer at the boundary | Clock not throttled | Clock not throttled | Nothing to time: one timeline |
| Memory | Small | Whole tracks decoded: 230 MB for 10 minutes of 48 kHz stereo | Small | Small (compressed) |
| Start latency | Fast | Whole track first | Fast | Fast |
| Support | All | All | Chrome 94, Firefox 130, Safari 26 | Chrome, Firefox, Safari; iOS Safari via `ManagedMediaSource` |
| Work | | Container parsing for gapless metadata | Demuxers for every container, our own resampler and time-stretch | Fragmented MP4 from the server (above) |

MSE is what Spotify's and YouTube Music's web players use, it plays through the browser's own pipeline (hardware decoding, the media session, `preservesPitch`), and appending the next track to the same buffer leaves nothing to time. The method is the one in Chrome's [Media Source Extensions for Audio](https://web.dev/articles/mse-seamless-playback): for each track, `timestampOffset = trackStart − priming / rate`, `appendWindowStart = trackStart`, `appendWindowEnd = trackStart + frames / rate`, using the descriptor's numbers, where `trackStart` is the sum of the real lengths before it. With the server's last-packet fix this is sample-exact for FLAC and AAC in Chromium (below). Opus is left out of MSE: one decoder runs across every track appended to a `SourceBuffer`, and its state from one encode spoils the first 17 ms of the next.

### Web measurements

The same split chirp, played in Playwright's Chromium 159 (headless shell) through a page whose `<audio>` element runs into an `AudioWorklet` recorder at the codec's own rate. The recorder was checked first: `ref.wav` played whole, through an element and through an `AudioBufferSourceNode`, and one continuous FLAC through MSE, all came out bit-exact with no gap. "Wrong" counts samples that differ from ffmpeg's decode of each half. Firefox and WebKit were not installed and were not tested.

| Delivery and method | Boundary (samples) | Wrong |
| --- | --- | --- |
| FLAC in fragmented MP4, MSE, any method | **0** | none (bit-exact) |
| AAC in fragmented MP4 as ffmpeg writes it, MSE with the descriptor's numbers | +43 (1.0 ms) | none |
| AAC with the last packet's duration set to 1,024, MSE with the descriptor's numbers | **0** | none (bit-exact) |
| AAC with an edit list and priming also subtracted by the page | -981 | the next track's first 1,024 |
| Opus in fragmented MP4, last packet fixed, MSE | 0 | the next track's first 806 (16.8 ms), from decoder state carried across |
| Opus in WebM, MSE | -48 (WebM timestamps are whole milliseconds) | the next track's first 806 |
| MSE with no offsets or windows (AAC) | +1,067 (24.2 ms) | none |
| **Today: two elements, Ogg Opus, timer handoff** (5 runs) | +362 (7.5 ms of silence), every run | the next track's first 312 (6.5 ms) |

`sequence` and `segments` modes gave the same numbers for files without an edit list, and `changeType()` between same-codec tracks changed nothing. `createMediaElementSource` has to be connected before the element gets its source: connected afterwards, Chromium sometimes ran the element at the device rate and resampled twice.

**The engine as built (W2).** `scripts/e2e-engine.mjs` repeats the measurement through `MseEngine` and the server's own streams: the halves of the split tone from `test/audio.ts`, fetched from `/stream`, recorded by an `AudioWorklet` at 44.1 kHz and compared with ffmpeg 9.0.2's decode of the same bytes (cut by the descriptor's numbers) and with the uncut chirp. Playwright's Chromium 159; "differs" counts samples more than 1e-6 (-120 dBFS) apart, since two builds of the same decoder differ in the last bits of a float.

| Delivery | Boundary (samples) | Differs from ffmpeg's decode |
| --- | --- | --- |
| `flac_mp4` (an ALAC source) | **0** | none (bit-exact) |
| `copy_mp4` (a FLAC source) | **0** | none (bit-exact) |
| `aac_mp4_256` | **0** | none after each track's first 4,096 samples |
| `copy_mp4` (an AAC source) | **0** | none after each track's first 4,096 samples |
| Original MP3 (LAME tag) as an `audio/mpeg` byte stream | **0**, with the correction below | none after each track's first 1,152 samples |

- **A lossy decoder carries its state into the next track.** Chromium does not run the frame the append window cuts (the priming) through the decoder, so each track's first AAC frame is decoded from the state the decoder is in: the previous track's, or none. Up to 2.1e-3 apart in that frame, then traces under -100 dBFS for two more. It is not less accurate: over the first 4,096 samples the recording is as far from the original chirp as ffmpeg's own decode of that track (-67.9 against -68.0 dBFS RMS at the boundary, -61.2 against -61.2 at the start), so nothing changes that can be heard. The spike above counted these samples as right.
- **MP3.** Chromium's MPEG byte stream skips the LAME frame and drops the decoder's 529-sample delay itself, and the descriptor's priming (ffmpeg's `skip_samples`) includes it, so the engine subtracts 529 for `audio/mpeg`. MP3 originals then join exactly too.
- **Seeks** inside and outside what is appended land on the sample (within 0.02 ms) for `flac_mp4`, `aac_mp4_256` and `copy_mp4`, forward and back.
- **A background tab.** Four tracks (the halves twice) in a minimized window, whose timers ran 2.4 times a second with the page's main thread held 400 ms at each: three boundaries, each 0 samples, nothing differing. Playwright keeps every page "visible", so the page's own `visibilityState` could not be made `hidden`.
- **WebKit** (Playwright's 27.2, Safari 27's engine) plays MSE, but `createMediaElementSource` on an element fed by a `MediaSource` outputs silence, so normalization could not run and nothing reaches a recorder. Safari keeps `WebPlayerEngine`.
- **Firefox** was not measured: Playwright's Firefox build does not start on macOS 27 and no other Firefox was available. It keeps `WebPlayerEngine`.

### Design

- **`MseEngine`** (`apps/web/src/player/engine/mse-engine.ts`) implements `PlayerEngine` on one `<audio>` with a `MediaSource` and one `SourceBuffer` (`audio/mp4`, `mode = 'segments'`). The current and next entries are fetched with streaming `fetch` and appended as bytes arrive; a codec change between entries uses `changeType()`. At most 60 s behind the playhead are kept (`remove()`), and `QuotaExceededError` drops more. As built:
  - Engines get the descriptor's `profile`, `mime`, `codec`, `sampleRate`, `durationMs` and `gapless` with each URL (`EngineLoad.media` in client-core, which M1's native engine reads for `transcoded` and `gapless`), and the page asks the server for what its engine plays (`containers=fmp4&engine=mse` and the codecs `MediaSource.isTypeSupported` accepts; WebKit spells FLAC `fLaC`).
  - Appends keep 30 s ahead of the playhead, sized from the stream's bytes per second once known, so a hi-res stream stays within the browser's audio buffer quota (a refused append is retried once some has played). A download stops reading while 8 MB wait to be appended. The preload's download starts at once; it is appended after the loaded entry's last byte.
  - The `MediaSource` duration is set far past anything appended (and extended), not to infinity: with an infinite duration only what is buffered is seekable, and a seek past it is cut short.
  - A stream's first bytes are checked (`ftyp`, or an MPEG frame or ID3 tag) before any reaches the buffer: bytes that fail to parse would fail the whole `MediaSource`, and with it the entry already playing. If the element does fail on the preload's data, the loaded entry starts again on a fresh `MediaSource` where it was, without the preload.
  - A load of anything but the preloaded entry starts a fresh `MediaSource`, the entry at 0. Loading the preloaded entry keeps the timeline and moves the playhead to it.
  - At the end of the last entry the element runs dry and is paused a moment later, so nothing still in the output is cut, and a preload that arrives after the end waits for `play()`.
- **Boundaries.** The engine knows each entry's start on the element's timeline. A 250 ms interval (and `timeupdate`) checks `currentTime` against the next boundary, and within a second of it a timer reports it on time; each emits `ended` and `status`, so in a background tab the report may be late but the audio is not.
- **Seeking.** Inside the buffer: `currentTime`. Outside: a fetch with `start`, placed by `X-Squirmy-Start-Frame`, after `remove()` has cleared what the old stream appended from just before the new start: an old frame left straddling it, or a playhead moved before the removal, plays the old stream into the new one out of phase (measured: 3.7 ms off at an AAC seek). An original (MP3) is read from its start again, cut just before the seek.
- **Graph.** `MediaElementAudioSourceNode` → item gain (`GainNode`, changes ramped over 10 ms with `setTargetAtTime`, and moved to the next entry's gain at its boundary with a 5 ms ramp) → EQ (10 `BiquadFilterNode`s, peaking) → limiter (`AudioWorkletNode`, a module file under the web app's `assets/`, allowed by `script-src 'self'`: the CSP's `audioworklet` destination falls under `script-src-elem`) → destination.
- **The graph as built (W3).** One `OutputChain` (`apps/web/src/player/engine/output.ts`) serves both engines: `MseEngine`'s element and each of `WebPlayerEngine`'s two voices run through their own gain into it. Its equalizer path (a preamp of minus the largest boost, then the 10 filters, Q 1.41) is crossfaded against a straight path over 10 ms, so with the equalizer flat the filters are out of what plays and the samples pass untouched; band changes glide over 10 ms. The limiter (`limiter-worklet.js`) is the iOS engine's algorithm made to run on a stream: a worklet sees 128 frames at a time and none after them, so it looks ahead by delaying its output by its lookahead and its interpolator's reach (73 frames at 44.1 kHz, 1.7 ms). The module is a plain file, which Vite copies to `assets/` as it is; under the server's CSP (`script-src 'self'`, `worker-src 'none'`) it loads with no violation, checked against the built app. AudioWorklet exists only in secure contexts, so on plain HTTP on a LAN there is no limiter: the engines then report `limiter: false` and `canBoost: false`, and `gainFor` keeps its `1/peak` clamp and never turns a song up. The module loads after the context starts; until it is in the chain (and if it fails), the engines hold every gain to at most 1. Safari keeps `WebPlayerEngine` (its MSE element is silent in Web Audio), which runs the same chain.
- **Measured (W3)**, in `scripts/e2e-engine.mjs`, rendered offline through the chain in Playwright's Chromium 159 with the iOS engine's test values: a full-scale tone boosted 12 dB (60 Hz, 1 kHz, 9 kHz, at 44.1 and 48 kHz) peaks at -1.07 to -1.10 dBTP (4× oversampled with an interpolator of its own); a quarter-rate tone 45° off the samples (+1 dB) at -1.10 dBTP; sweeps at -40 dB, at -40 dB turned up 6 dB, and at -1.6 dB come out bit-identical, 79 frames (1.65 ms at 48 kHz) later; each equalizer band at -6 dB measures -6.00 dB at its centre, and a +6 dB band plays at 0 dB with its preamp. The W2 measurements above were repeated through the chain and are unchanged (FLAC bit-exact at every boundary, seeks on the sample, a background tab gapless). WebKit passes the same offline checks.
- **Output device.** `AudioContext.setSinkId` (Chrome and Edge 110+). Firefox and Safari have `setSinkId` only on media elements, which does nothing once the element plays into Web Audio, so the device picker is hidden there. As built, Chromium names its outputs (`enumerateDevices`) only to a page that may use the microphone, so Settings asks once, stops the microphone at once, and lists them; `selectAudioOutput` is used instead where a browser has it. The choice and the equalizer are kept per browser (localStorage), and a device that is gone leaves the system's default playing until it is back.
- **Crossfade.** A second element and `MediaSource` for the incoming track, its own gain node into the same EQ, both gains on equal-power curves on the `AudioContext` clock. Starting the incoming element is accurate to tens of milliseconds, which a fade hides.
- **Speed:** `playbackRate`, with `preservesPitch` (the default).
- **Fallback.** Without MSE (or `ManagedMediaSource` on iOS, which needs `disableRemotePlayback`, so no AirPlay from Safari), or without a supported codec, `WebPlayerEngine` stays, with its gain changes ramped. As built, `createBrowserEngine` (`engine/choose.ts`) picks `MseEngine` in Chromium only (client hints, or the user agent on plain HTTP, where there are none), from the measurements above.
- **Content-Security-Policy.** The element gets its `MediaSource` through a `blob:` URL, which `media-src 'self'` refuses (measured), so the server allows `media-src 'self' blob:`.

## Connect queue transport

### Diffs with checkpoints

- **Event.** `session:queueOps { version, queueVersion, baseQueueVersion, scope, lengths, ops }`, sent instead of `session:queue` to sockets that asked for it, just before the `session:state` of the same version, as `session:queue` is now. `lengths` are the five lists' lengths after the ops, for checking.
- **Ops** on the five lists of `SessionQueue` (`queue`, `history`, `autoplayQueue`, `playOrder`, `playedInCycle`): `splice { list, at, remove, insert }`, where an inserted entry is either a full entry or `{ ref: id }` naming an entry the base already has (ids map to identical entries in every list, `reducer.ts:461-482`); `removeIds { list, ids }` for `playOrder` pruning; `permute { list, from }` for shuffle; `patch { list, at, entry }` for an entry whose state or track changed.
- **Computed in `commit`** (`sessions/service.ts`), by a pure `diffQueue(prev, next)` in client-core, list by list, only for lists whose identity changed, trimming the common prefix and suffix and recognising "drop from the front, append" (history and the cycle at their caps). A track end becomes about 150 bytes. Diffing the result rather than replaying commands covers every change path (`heldOn`, `replaceQueue`, detach and attach, the trusted-entry rewrites in `checkCommand`) and does not depend on the server and the app running the same reducer version.
- **Checkpoints.** The full `session:queue` goes instead when the ops would inline more than 256 entries, carry a permutation over 2,000 long or exceed 64 KB (a new `playTracks`, a reshuffle), on every hello and move, and when a client asks with the new `session:sync` (rate limited like hellos).
- **Gaps.** The client tracks `queueVersion` (today it ignores it, `packages/client-core/src/session/client.ts:732-747`). Ops whose `baseQueueVersion` is not the one it holds, a `scope` that is not its session's (a detached device's session shares version numbers with the shared one), an unknown ref or a length mismatch make it ask for `session:sync`, keep applying states meanwhile, and adopt the checkpoint when it comes.
- **Compatibility.** A client asks with `accepts: ['queueOps']` in its hello; the server announces `queueOps` in its capabilities and puts each socket in a `#ops` or `#full` sub-room of the session room. Old clients get exactly today's messages; new clients against an old server never get ops. The full queue is serialized only if some socket needs it.

### Undo

- **Command** `undo { commandId }`, behind capability `undo`, for the commands that edit the queue: `removeFromQueue` (put the entry back after its old predecessor, by id), `enqueue` (remove the added entries still queued), `moveInQueue` (move it back), `clearQueue` (put the entries and `playOrder` back). Transport, settings and `playTracks` are not undoable.
- **Stack** on the server's session record, in memory: the last 20 undoable commands, each for 15 minutes, cleared by `playTracks`, `replaceQueue` and attaching with the queue. Applying an undo removes its entry; a missing one is acked `nothing_to_undo`.
- **Across devices.** Undo works by ids and anchors, so another device's later edits do not break it. Any device may send it; each app offers it for its own last edit, in the player's status line ("Removed … · Undo").
- It is an ordinary command: versions move forward and the change goes out as ops.

## Implementation plan

Each item is one pull request against `dev`, small enough for one agent. **Deps** must be merged first; items without deps can start at once.

### Server

**S1. `perf(streaming): prioritize and cancel transcodes`**
- Scope: `intent` on stream URLs; encoder slots as a priority queue; preemption by `play`; stopping abandoned encodes; four encodes per user.
- Files: `apps/server/src/modules/streaming/transcode.ts`, `routes.ts`, `apps/server/src/modules/subsonic/transcode.ts` (slot API only), `packages/contracts/src/playback.ts` (`StreamIntent`), tests; `docs/architecture.md` ("Playback and streaming").
- Deps: none.
- Acceptance: with two slots, ten `play` requests for different tracks a second apart leave at most two encoders running and the last starts within one encode's startup; an abandoned `play` encode under half done is gone 10 s after its reader; a `cache` encode survives its reader; Subsonic `media.test.ts` passes unchanged.
- Verify: on a local stack, skip quickly through ten untranscoded tracks on cellular quality and watch `ps` for ffmpeg processes.

**S2. `feat(loudness): exact lengths and estimated gains`**
- Scope: `media_files.decoded_frames`, `decoded_rate` and `priming_frames` (migration), filled by `loudness.measure` and the sweep; `gapless` in the descriptor for originals; the library's median track gain with `estimated: true` for unmeasured files; a high-priority measurement when an unmeasured file is played.
- Files: `apps/server/src/modules/loudness/*`, `apps/server/src/database/schema.ts` and a migration, `apps/server/src/modules/streaming/playback.ts`, `packages/contracts/src/playback.ts`, tests.
- Deps: none.
- Acceptance: for tones from `test/audio.ts` in every fixture format, `decoded_frames` equals ffmpeg's decoded count; MP4 and MP3 fixtures report their encoder's priming; an unmeasured file's descriptor has the median gain and `estimated: true`, and playing it queues `loudness.measure`.

**S3. `feat(streaming): fragmented MP4 profiles with exact gapless numbers`**
- Scope: profiles `flac_mp4`, `opus_mp4_192`, `opus_mp4_96`, `aac_mp4_256`, `aac_mp4_128` and `copy_mp4`; `containers=fmp4` in `PlaybackQuery` and `chooseProfile`; FLAC for lossless sources the client cannot decode; `gapless` for transcodes; the last-packet rewriter; `start` seeking for transcodes with `X-Squirmy-Start-Frame`.
- Files: `apps/server/src/modules/streaming/{profiles,select,transcode,playback,routes}.ts`, a new `mp4.ts`, `apps/server/src/test/audio.ts` (a split-tone helper), `packages/contracts/src/playback.ts`, tests; `docs/architecture.md`, `docs/server/playback.md` ("Quality and transcoding").
- Deps: S2 (lengths). S1 is not required.
- Acceptance: for each new profile, both halves of a split tone fetched through `/stream` (live and cached) decode with ffmpeg to the original's frame count after trimming by the descriptor's numbers, and the boundary cross-correlates to 0 samples (±1 when resampled); the last `trun` sample of every AAC and Opus output stores the full frame; a `start` request's first real sample is the requested one; old clients' profile choices are unchanged (existing `select.test.ts` cases pass).

### Connect

**C1. `feat(sessions): queue diffs with checkpoints`**
- Scope: as in [Diffs with checkpoints](#diffs-with-checkpoints).
- Files: `packages/contracts/src/session.ts`; `packages/client-core/src/session/{queue-ops,client,transport,index}.ts`; `apps/server/src/modules/sessions/{service,socket}.ts`; `apps/web/src/test/fake-services.ts`; tests; `docs/architecture.md` ("Realtime", "Sessions").
- Deps: none.
- Acceptance: over seeded random command sequences, applying `diffQueue(prev, next)` to `prev` gives `next` and leaves untouched lists identical; a track end on a 10,000-entry queue sends under 1 KB to an ops socket while an old socket still gets `session:queue`; a version gap triggers `session:sync`; detach, attach and `session:moved` keep working (`detach.test.ts`).
- Verify: two browsers and the phone in one session with a 5,000-track queue; skip ten times and compare the socket's frame sizes in devtools.

**C2. `feat(sessions): undo queue edits`**
- Scope: as in [Undo](#undo), with the status-line Undo on web and iOS (the smallest UI change; call it out).
- Deps: C1.
- Acceptance: each undoable command round-trips; undo after another device's edit restores by anchor; a duplicate undo is `nothing_to_undo`.

### iOS and tvOS

**M1. `feat(mobile): native audio engine`**
- Scope: the Expo module `apps/mobile/modules/audio-engine` (iOS and tvOS) with its Swift core package: `ByteCache` with Range requests, `FileDecoder`, a first `StreamDecoder` for today's live transcodes, the gapless timeline, the feed loop with route-dependent lead and underrun handling, the renderer and synchronizer, the audio session (long-form, interruptions, route changes, media services reset), silence while loading, the clock notification for Now Playing; `NativeEngine` implementing `PlayerEngine`; the `playbackEngine` setting with fallback; the config plugin's `Info.plist` key. Plays originals gaplessly and today's transcodes with today's gaps (ADTS, MP3).
- Files: `apps/mobile/modules/audio-engine/**`, `apps/mobile/src/player/engine/{index,NativeEngine}.ts`, `apps/mobile/modules/now-playing/ios/NowPlayingModule.swift` (observe the clock notification), `apps/mobile/src/playback.tsx` (engine choice), `packages/client-core/src/engine.ts` (optional `EngineLoad` fields), tests; `docs/architecture.md` (Clients, mobile), `docs/use/ios.md` (the setting).
- Deps: none.
- Acceptance: `swift test` decodes split tones in FLAC, ALAC, AAC (MP4), MP3 with a LAME tag and Ogg Opus to an exact boundary through `FileDecoder` and the timeline; the PCM handed to the renderer for two consecutive items equals the uncut original; the lead never reaches zero in a 60 s run; a starved source stops the clock and resumes at the same position; `NativeEngine` passes the `PlayerEngine` contract cases.
- Verify on a device: gapless album (a live album or a DJ mix) through the speaker, wired headphones, Bluetooth and an AirPlay 2 speaker; a phone call and Siri mid-song; unplugging headphones; locking the phone through three track changes; starting from the lock screen and from Control Center; switching to AirPlay mid-song. Compare with the `classic` engine on the same tracks.

**M2. `feat(mobile): stream to cache in one pass`**
- Scope: `prefetch`, `cacheComplete` and moving completed files into downloads; `StreamingCache` registers the engine's files and no longer fetches the current stream (`streamingCache/model.ts` `policyFor`); caching on cellular.
- Files: `apps/mobile/src/streamingCache/*`, `apps/mobile/src/downloads/manager.ts` (a cached file becomes a download), the module's cache API, tests; `docs/architecture.md` ("Streaming cache", "Downloads").
- Deps: M1.
- Acceptance: playing a track on Wi-Fi makes exactly one request stream for it (server log or a fake server in the module tests); the cache row appears when it completes; a download of a cached track moves the file; eviction still spares entries about to play.

**M3. `feat(mobile): fragmented MP4 transcodes and live seeking`**
- Scope: fragmented MP4 in `StreamDecoder`, trimming with the descriptor, `start` seeks past what has arrived, the Opus probe and `containers=fmp4`.
- Deps: M1, S3.
- Acceptance: `swift test` on split tones of every S3 profile gives exact boundaries; a seek past the downloaded part of a live transcode plays the right sample (cross-correlated against the original).
- Verify: cellular quality `data_saver` (Opus) through an album; seek ahead in a song that is still transcoding.

**M4. `feat(mobile): normalization with boost and a limiter`**
- Scope: the DSP chain's gain and true-peak limiter; `canBoost: true`; `gainFor` with `limiter` and `targetLufs` (client-core, shared with the web); the target setting in Settings → Playback (synced in `UserSettings` as `normalizationTarget`).
- Files: the module's DSP, `packages/client-core/src/normalization.ts`, `packages/contracts/src/settings.ts`, `apps/mobile/src/` settings, tests; `docs/use/ios.md`.
- Deps: M1; S2 for estimated gains (works without).
- Acceptance: the limiter keeps a +12 dB boosted full-scale tone under -1 dBTP measured 4× oversampled, and leaves a signal under the ceiling bit-identical; `gainFor` tests cover every mode with the new options.

**M5. `feat(mobile): equalizer`** — bands, presets and preamp in the DSP chain and a Settings screen. Deps: M4. Acceptance: each band's measured response is within 0.5 dB of its setting at its centre frequency; a change mid-song produces no step larger than the 10 ms crossfade allows. Done: `EqualizerTests` measures every preset and several custom curves with sines at each centre (within 0.5 dB of the setting) and between them (within 0.05 dB of the designed response), at 44.1 and 48 kHz.

**M6. `feat(mobile): crossfade`** — the timeline's mixing, the album-run rule, the engine contract sentence, the setting. Deps: M4. Acceptance: two tones crossfaded over 4 s have constant power within 0.5 dB through the fade; consecutive album tracks are gapless with crossfade on; `ended` arrives when the incoming item starts. Done: `CrossfadeTests` (power, the curves' timing, `ended`, album runs, skips, seeks, replaced and late preloads, the sleep timer's fade, rendering again); the sleep timer's fade goes through `PlayerEngine.setFade` so it reaches both entries of a crossfade.

**M7. `feat(sessions): playback speed`** — `rate` in the session state and position arithmetic (contracts, reducer, server), the engine's rate and pitch algorithm, the control (hidden on AirPlay). Deps: M1. Acceptance: reducer tests for position at 0.5× and 2×; an old client's optimistic state is corrected by `syncPosition`.

**M8. `feat(mobile): AirPlay 2 buffering`** — the 10 s lead on AirPlay, flushing ahead for edits and settings, recovery from automatic flushes and output configuration changes, start once `hasSufficientMediaDataForReliablePlaybackStart`. Deps: M1. Verify: play to one and to two AirPlay 2 speakers (multi-room from Control Center); skip, edit the queue and change EQ while playing there; walk out of Wi-Fi range briefly; switch between the phone speaker and AirPlay mid-song.

**M9. `feat(mobile): make the native engine the default`** — after M1 to M3 and M8 have been on TestFlight for a release: default `native`, then remove `ExpoAudioEngine`, `silence.m4a`, `holdBackgroundTime` and `expo-audio`. Deps: M1, M2, M3, M8.

### Web

**W1. `fix(web): ramp gain changes`** — `setTargetAtTime` over 10 ms in `WebPlayerEngine.applyGain` (`web-engine.ts:380-383`). Deps: none. Acceptance: a test with a fake `AudioContext` sees a ramp, not a jump.

**W2. `feat(web): gapless playback through Media Source Extensions`** — `MseEngine`, `containers=fmp4`, fallback to `WebPlayerEngine`. Deps: S3. Acceptance: in `apps/web/scripts/e2e-engine.mjs` (Chromium), two halves of a split tone in `flac_mp4` and `aac_mp4_256`, recorded through an `AudioWorklet` tap, meet at 0 samples with no sample wrong (as in [Web measurements](#web-measurements)); seeking inside and outside the buffer lands within 10 ms; the existing engine contract cases pass. Verify: Chrome, Firefox and Safari on a gapless album; a background tab through three track changes.

**W3. `feat(web): limiter, equalizer and output device`** — the graph, the worklet, `setSinkId`, the settings (target shared with M4; EQ per browser). Deps: W2, M4's client-core change. Acceptance: the same limiter test values as M4, run in Chromium on the worklet.

**W4. `feat(web): crossfade`** — the second element. Deps: W3. Acceptance: as M6, recorded in Chromium.

### Order

```
S1 ─────────────────────────────────────────────┐
S2 ──► S3 ──┬──► M3 ──┐                          │
            └──► W2 ──► W3 ──► W4                │
M1 ──┬──► M2 ────────┼──► M9 (after a TestFlight release)
     ├──► M4 ──► M5, M6
     ├──► M7
     └──► M8 ────────┘
C1 ──► C2
W1
```

S1, S2, C1, M1 and W1 can start together.

## Risks

- **Opus on old iOS versions.** Only iOS 27 could be tested here. The runtime probe falls back to AAC, so the worst case is AAC's bitrate, not silence.
- **`AudioFileStream` on old iOS versions** for fragmented MP4. Measured on iOS 27 only; if it fails on 16.4 to 26, the fallback is a small fragmented-MP4 parser of our own feeding `AudioConverter` (our own ffmpeg output is a narrow, known shape), or raising the engine's minimum iOS.
- **The renderer's behaviour on AirPlay** (how far it pulls, whether `flush(fromSourceTime:)` works there 1.5 s ahead, rate changes) is documented loosely and was not testable without a receiver. M8 verifies it on hardware before the engine becomes the default.
- **No analog capture.** Gaplessness was proven at the renderer's input with the lead above zero, not by recording the output. M1's device verification includes listening tests on gapless material.
- **The web is gapless in Chromium only.** Firefox trims frames that straddle the append window (Mozilla bugs 1524890, 1222851) and applies no edit lists in MSE (1941303), which the design does not rely on; it could not be measured here (see [the engine as built](#web-measurements)). WebKit plays MSE but not into Web Audio, which normalization and the limiter need. Both keep `WebPlayerEngine` until a measurement says otherwise; `scripts/e2e-engine.mjs --browser webkit` repeats it.
- **Two decoders on iOS** (`FileDecoder` for originals, `StreamDecoder` for transcodes) could disagree on a format they both read. Each kind of delivery goes through exactly one of them (originals through `FileDecoder`, transcodes through `StreamDecoder`), and each has its own exactness tests.
