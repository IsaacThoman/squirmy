# Sonic analysis

Squirmy listens to every song on your server and measures how it sounds: its tempo and beat, its key, how energetic and danceable it is, where it really starts and ends, and a description of its sound. Radio and Autoplay use these measurements to choose songs that sound alike, and to order them so tempo, key and energy flow from one song to the next. The analysis runs on your server; no audio and nothing measured from it leaves the server.

## What it measures

| Measurement | What it is |
|---|---|
| **Tempo** | Beats per minute, how steady the beat is, and where the first beat falls. A fast song may be measured at half its tempo (87 rather than 174 BPM); radio treats the two as the same tempo. |
| **Key** | The key and mode ("A minor"), with how clearly the music sits in it, and its Camelot code ("8A"), the wheel DJs mix by. |
| **Energy** | 0 to 1: how loud, busy and bright the song is. |
| **Danceability** | 0 to 1: how steady and pronounced the beat is, at a tempo people dance to. |
| **Start and end** | Where the sound starts and stops (leaving out silence), where a quiet intro or fade-in reaches the song's usual level, and where a fade-out or quiet ending begins. |
| **Sound** | A summary of the song's timbre, its spectrum and its rhythm, used to find songs that sound alike. |

Squirmy measures these itself, with no extra software: ffmpeg (already in the image) decodes the audio and Squirmy's own code analyses it. It works the same on ARM (Raspberry Pi, most NAS boxes) and x86 servers, and needs nothing from Postgres beyond what Squirmy already uses.

## Tags come first

Tempo, key and mood tags in your files are read whether or not the analysis is on, and they win over the analysis for tempo and key: DJ software such as Mixed In Key, Rekordbox and Traktor usually measures them better than a general analysis.

| Tag | Read from |
|---|---|
| Tempo | `BPM` (FLAC, Ogg), `TBPM` (MP3), `tmpo` (MP4) |
| Key | `INITIALKEY` or `KEY` (FLAC, Ogg, MP4), `TKEY` (MP3); names ("Am", "F#", "Bb minor"), Camelot ("8A") and Open Key ("1m") |
| Mood | `MOOD` (FLAC, Ogg, MP4), `TMOO` (MP3) |

For a song with no tempo tag and no measured tempo (the analysis is off, or could not read the file), Squirmy asks Deezer for its tempo when Deezer is on and the song is linked to Deezer. Deezer's tempo is often double or half the felt tempo; it is used only when nothing else is known.

## How long it takes

Analysis runs in the background, one song at a time at the lowest CPU priority, after the song's [loudness](./playback.md#loudness-normalization) is measured. It uses at most one CPU core however many songs are waiting, and it never holds up browsing or playback.

On an Apple Silicon Mac a four-minute song takes about 0.6 seconds: 0.4 seconds of analysis and 0.2 of decoding. A Raspberry Pi 5 is several times slower (not measured yet; expect 2 to 4 seconds). So a library of 20,000 songs takes a few hours on a desktop and about a day on a Pi 5. Songs longer than half an hour (DJ mixes, live sets) are analysed for their first 30 minutes.

**Admin → Library** shows how many songs are analysed under **Sonic analysis**, and **Admin → Jobs** shows the `sonic.analyze` queue.

## Turning it off

**Admin → Server settings → Library → Sonic analysis** switches it off and on. It is on by default.

- **Off** stops new analysis. Songs already measured keep their measurements, and radio still uses them. Tempo, key and mood tags are still read, and Deezer's tempo is still used for songs nothing else describes (with Deezer on).
- **On again** carries on where it stopped, starting within a minute.

## How radio uses it

- **Sounds alike.** Songs are compared by their place in your library: the song nearest the seed scores highest, a typical song much less. The few songs closest to the seed count as related to it, so a radio holds together even when your tags have few genres and Deezer is off.
- **Flow.** Each next song is chosen with a small penalty for a jump in tempo (more than about 3%, but double or half time is fine), a key that clashes on the Camelot wheel, or a jump in energy. These weights are small: they reorder songs that were close anyway, and never override who the seeds are.
- **Songs that sound like this.** In the web app, a song's menu starts a radio that leans on sound much more than on artist and genre. A song that is not analysed yet gets an ordinary radio, and its analysis is queued at once.
- Songs the server would fetch through a [provider](./acquisition.md) have no file to analyse. In ordinary radio they count as average, so analysis never favours songs you own. In a "sounds like this" radio they rank below songs known to sound alike.

## When a file cannot be analysed

A file ffmpeg cannot decode is counted under **could not be decoded** in **Admin → Library**, and is not tried again until its audio changes. Its tempo, key and mood tags are still used.
