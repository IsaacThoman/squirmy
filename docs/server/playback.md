# Playback

This page explains how Squirmy streams audio, when it converts it, how volume normalization works, and how one playback session moves between your devices.

## Streaming

A client asks the server how to play a track and gets back a signed URL, valid for 12 hours, that works without any other credentials. Browsers, iOS's player and download managers can all use it directly, with HTTP Range requests for seeking.

When an album has several files for the same track, the server picks the file on the album being played first, then lossless over lossy, then the higher bitrate.

### Quality and transcoding

Each user picks a streaming quality in **Settings → Playback** (web) or **Settings → Streaming Quality** (iOS): one for Wi-Fi and the browser (default **Original**), one for cellular on iOS (default **High**).

| Quality | What is sent |
|---|---|
| **Original** | The file as it is, when the device can play its format. Otherwise AAC at 256 kbps. |
| **High** (AAC 256) | AAC at 256 kbps. A lossy file already at or below that bitrate, in a format the device plays, is sent as it is. |
| **Data saver** | Opus at 128 kbps where the device plays Opus (current browsers), otherwise MP3 at 192 kbps (iOS). |

Each client says which formats it decodes. The iOS app lists FLAC, ALAC, AAC, MP3, WAV and AIFF, so an Opus, Ogg Vorbis or WMA file is converted to AAC for it even at **Original**.

Conversions are done with ffmpeg and sent while they are encoded, so playback starts after a moment rather than after the whole file. At most half the CPU cores (at least two) encode at once. Subsonic apps can also ask for MP3 at 320 or 192 kbps; see [Subsonic clients](./subsonic.md#streaming-and-transcoding).

### The transcode cache

Every conversion is kept in `<data>/transcodes/`, so the second play of a track starts at once and seeks like the original. The cache is capped by **Management → Server settings → Playback → Transcoding → Transcode cache** (default 10 GB). Once an hour, the least recently used conversions beyond the cap are deleted. The folder is safe to delete at any time; it refills as people listen.

## Loudness normalization

Albums are mastered at very different levels. Normalization evens them out so you do not reach for the volume between songs.

**What is measured.** Each file's integrated loudness and true peak are measured with ffmpeg's EBU R128 filter, in the background at low priority. Each album is also measured as a whole, with its tracks played in order, so the quiet and loud songs of one album keep their relationship. Until a file is measured, its ReplayGain tags are used if it has them. The target is -18 LUFS, the ReplayGain reference.

**The modes**, per user in **Settings → Playback → Volume normalization** (web) or **Normalize Volume** (iOS):

| Mode (web / iOS) | Gain used |
|---|---|
| **Automatic** (default) | The album's gain when you play an album in order; each song's own gain otherwise (playlists, shuffle, radio). |
| **Per song** / **Track** | Each song's own gain. |
| **Per album** / **Album** | The album's gain, falling back to the song's. |
| **Off** | None. |

**How clients apply it.** The gain is applied on the device, never baked into the stream. A gain is limited so the track's peak does not clip. The web app can raise quiet tracks as well as lower loud ones. The iOS app can only lower: a track quieter than the target plays at its own level.

## Devices and transferring playback

Each user has **one** playback session, held by the server: the queue, the current track and position, shuffle and repeat, and which device is playing. Every signed-in browser tab and phone is a device in that session.

- **One device plays; every other one is a remote.** Open the web app while your phone plays and you see the same track at the same position, with the controls driving the phone. The web app shows "Playing on …" with **Play here**; the iOS app shows "Playing on …" in the **Playback device** sheet.
- **Pressing play when nothing is playing** makes the device you pressed it on the player.
- **Transferring.** Open the devices list (the **Devices** button in the player bar on the web; on iOS, the playback device button in the mini-player or Now Playing, which opens the **Playback device** sheet) and pick a device. Playback continues there from the same position. Each device keeps its own volume.
- **Each browser tab is its own device.** A second tab of the same browser is listed with "(2)" after its name. Rename the browser in **Settings → Playback → This browser's name**.
- **When the playing device disappears**, the server waits 20 seconds, then pauses the session at the last known position. Any device can resume it.
- **A device is listed only while it is connected.** iOS suspends an app that is paused in the background, so a paused phone drops off the list until it is opened again.

Browsers may refuse to start audio until you have clicked on the page. When that happens after a transfer or a reload, the web app shows "Your browser is holding back audio" with **Enable audio**.

### Gapless playback

The playing device loads the next track before the current one ends. In the web app the measured gap between tracks is a few milliseconds. On iOS the next track starts as the previous one ends, which is close to gapless but not sample-accurate: a continuous live album can have a tiny audible seam.

## What "preparing" means

A track shows **Preparing…** when it is playable on demand through an [acquisition provider](./acquisition.md) and its file is still being fetched. The session waits at the start of the track and begins as soon as the file arrives. The server starts fetching the next tracks in the queue ahead of time. If the fetch fails, the track is skipped with a notice and stays gray for a day.

On a server without acquisition providers, nothing is ever preparing.
