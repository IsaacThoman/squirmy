# Playback

This page explains how Squirmy streams audio, when it converts it, how volume normalization works, and how one playback session moves between your devices.

## Streaming

A client asks the server how to play a track and gets back a signed URL, valid for 12 hours, that works without any other credentials. Browsers, iOS's player and download managers can all use it directly, with HTTP Range requests for seeking.

When an album has several files for the same track, the server picks the file on the album being played first, then lossless over lossy, then the higher bitrate.

When the server has measured the original file, its playback descriptor includes the exact decoded frame count, sample rate and source priming. Clients that use those values can identify the track's exact boundary.

### Quality and transcoding

Each user picks a streaming quality in **Settings → Playback** (web) or **Settings → Streaming Quality** (iOS): one for Wi-Fi and the browser (default **Original**), one for cellular on iOS (default **High**).

| Quality | What is sent |
|---|---|
| **Original** | The file as it is, when the device can play its format. Otherwise AAC at 256 kbps. |
| **High** (AAC 256) | AAC at 256 kbps. A lossy file already at or below that bitrate, in a format the device plays, is sent as it is. |
| **Data saver** | Opus at 128 kbps where the device plays Opus (current browsers), otherwise MP3 at 192 kbps (iOS). |

Each client says which formats it decodes. The iOS app lists FLAC, ALAC, AAC, MP3, WAV and AIFF, so an Opus, Ogg Vorbis or WMA file is converted to AAC for it even at **Original**.

Conversions are done with ffmpeg and sent as they are encoded, so playback can start while the rest of the file is being converted. The server reserves at most half the CPU cores (at least two) for encoders, with up to four concurrent conversions started by each user. New playback gets priority over preloading, cache fills and downloads. If a download or cache fill is interrupted to make room for playback, its conversion starts over when requested again. Subsonic apps can also ask for MP3 at 320 or 192 kbps. See [Subsonic clients](./subsonic.md#streaming-and-transcoding).

### Seeing what plays

Now Playing shows a **Lossless** badge while the device playing receives a lossless file as it is, and **Hi-Res Lossless** when that file is above 48 kHz or 16-bit. A lossy stream has no badge, and neither has a lossless file converted on its way (by **High**, **Data saver**, or a device that can't play its format). The badge and **Track info** in the song's menu open the song's details: its file (format, sample rate, bit depth, bitrate, channels, size), what the device receives (the file as it is, or a conversion and why), the volume normalization applied, and the device playing. Each device says this itself, so a phone controlling a TV shows what the TV plays. A device running an older version of Squirmy doesn't say, and its listeners see no badge.

### The transcode cache

Completed conversions are kept in `<data>/transcodes/`, so the second play of a track starts at once and seeks like the original. If everyone leaves a stream early, the server gives readers up to 10 seconds to reconnect before stopping the conversion. Cache fills, downloads and conversions already at least halfway through the track keep running after a disconnect. The cache is capped by **Admin → Server settings → Transcoding → Transcode cache** (default 10 GB). Once an hour, the least recently used conversions beyond the cap are deleted, except those played in the last half hour. The folder is safe to delete at any time and refills as people listen.

## Loudness normalization

Albums are mastered at very different levels. Normalization evens them out so you do not reach for the volume between songs.

**What is measured.** Each file's integrated loudness and true peak are measured with ffmpeg's EBU R128 filter, in the background at low priority. The same decode records the exact number of audio frames and the source's encoder delay and trailing padding as reported by ffmpeg. The server decodes the tracks of an album one at a time into a continuous measurement. The album true peak is the highest of the track true peaks. The target is -18 LUFS, the ReplayGain reference.

**While a file awaits measurement.** The server uses its ReplayGain tags when present. Without tagged gains, the track gain is estimated from the median track gain of the library, when available. Streaming the track moves its measurement ahead of the background queue. Playback descriptors requested after measurement carry the track's own gain.

**Decode failures.** After retries, the server records the error for the file and clears its measured gains and exact length, along with its release's album measurement. The next scan that detects a change to the file retries measurement. Check the failed `loudness.measure` job when investigating an unreadable file.

**The modes**, per user in **Settings → Playback → Volume normalization** (web) or **Normalize Volume** (iOS):

| Mode (web / iOS) | Gain used |
|---|---|
| **Automatic** (default) | The album's gain when you play an album in order; each song's own gain otherwise (playlists, shuffle, radio). |
| **Per song** / **Track** | Each song's own gain. |
| **Per album** / **Album** | The album's gain, falling back to the song's. |
| **Off** | None. |

**How clients apply it.** The gain is applied on the device and capped using the peak for the selected gain. If the chosen gain is unavailable, clients try the other gain. When neither is available, playback uses the current volume with no normalization adjustment. The web app can raise quiet tracks as well as lower loud ones. The iOS app can only lower volume.

## Listening history

Squirmy records app plays with less than five seconds of listening as early skips when the play closes. They stay out of listening history, Home's rows, Subsonic's recently and frequently played albums, and scrobbles. Radio and Autoplay slightly lower a track's ranking if you skipped it early at least twice in the past 30 days.

Home's **Most played** counts the past 90 days of plays that reached half the song or four minutes, whichever came first; so do mixes, **Your top artists** (30 days) and **Rediscover**, and Subsonic's `frequent` album list (all time). Scrobbles use the same listening threshold. **Jump back in** and Subsonic's `recent` list count every play but early skips.

Mixes, **Because you listened to**, **Your top artists**, **Rediscover** and the time-of-day order are worked out once a day per listener, in the background: at 05:00 (server time) for everyone who played something in the past 90 days, and when someone opens Home after listening since theirs were made on an earlier day (or over an hour ago, when that run made no mixes). Similar artists come from the same sources as radio (Deezer, and ListenBrainz with a token; see [Metadata and privacy](./metadata-and-privacy.md)); with both off, mixes go by genres and listening alone and **Because you listened to** is not shown.

## The queue

The queue works as in other streaming apps:

- **Playing a song from a list** (an album, a playlist, an artist's top songs, search results, liked songs) plays the whole list from that song. **Previous** goes back through the songs before it, and **Repeat** comes round to the first song after the last. Previous never goes back past the start of the list into what played before it: on the first song it starts the song again.
- **Shuffle** shuffles what is still to come of the list, including songs before the one you started from. Turning it off goes back to the list's order after the song that is playing.
- **Clicking a song further down Up next** jumps there: the songs above it are skipped, and Previous goes back through them. Songs you added with **Play next** or **Add to queue** stay queued, keep their place when you shuffle, and are not repeated.

## Sleep timer

The sleep timer stops playback after a length of time (5, 10, 15, 30 or 45 minutes, or an hour), at the end of the song that is playing, or at the end of the album, playlist or queue (before Repeat starts it over or Autoplay suggestions begin).

- **It belongs to the session, not to a device.** Set it on your phone while the Apple TV plays, and the Apple TV stops. It stays through a transfer to another device, and every device shows it.
- **The server keeps it.** The timer runs on the server, so it stops playback on time even if the phone that set it is locked, asleep or gone.
- **The music fades out** over the last ten seconds on the device that plays, then pauses. Its volume is back where it was for when you play again. A device on an older version of the app does not fade: it just pauses.
- **"End of song" stops at the end of whatever song plays**, even after you skip. Playback moves on to the next song and pauses there, so play continues from it. It also stops a song on **Repeat one**.
- **Playing separately.** When the device that plays [steps out of the session](#devices-and-transferring-playback), the timer goes with it; a device that was not playing starts its own session without one.

Set it from Now Playing: the moon button on the web, the **⋯** menu on iOS ([web](../use/web.md#playing-music), [iOS](../use/ios.md#using-it), [Apple TV](../use/apple-tv.md#now-playing)). Servers older than this feature do not offer it.

## Listening together

**Listen together** lets people with accounts on the same server hear the same music at the same time, each on their own phone, browser or Apple TV. One person hosts: what they play plays for everyone, in step.

- **Starting and inviting.** The host starts it from the devices list ([web](../use/web.md#listening-together), [iOS](../use/ios.md#listening-together)), then shares the invite link or invites people from a list of the server's other users, who get an invite wherever they are signed in. The link works for anyone signed in to this server and only while the session lasts; it is long and random, so it can't be guessed. Nobody outside the server can use it.
- **Who controls what.** The host plays, pauses, seeks, skips, shuffles and picks what plays. The host chooses who can add songs: **Everyone** (the default) or **Only me**. When everyone can, a member's Play adds the song to the queue for everyone, and members can take back songs they added. Each listener keeps their own volume and chooses which of their own devices plays. Up to 16 people can be in one session.
- **In step.** Each device plays the music itself, from the same clock on the server, the way a device follows a seek. A member's device that drifts more than about a third of a second (a slow start, a stall) catches up by itself. The first device to reach the end of a song moves everyone on. When the host's device stops (it buffers, or goes away), everyone's clock waits for it; a member's device that stalls catches up and never holds anyone else back.
- **Who added what.** The queue shows who added each song, with their initials.
- **History.** Plays count for each listener, with the usual rules for skips and completed plays (see [Listening history](#listening-history)), and scrobble from each listener's own account.
- **Leaving.** A member who leaves, or whom the host removes, keeps what was playing, paused where it was. When the host ends the session, everyone's copy pauses the same way, and the host's own music plays on. Joining replaces what the member was playing.
- **Limits.** A device that [plays separately](#devices-and-transferring-playback) can't join or host; rejoin your other devices first. Only the host's sleep timer works during the session, and it pauses everyone. A server restart keeps the session. Apps from before this feature still follow along in a session, but don't show who is in it, and the server refuses their playback controls while they are a member.
- **Privacy.** Nothing is shared until someone starts a session. Members see the names of the people in it (display name, else username) and what plays. The invite list shows the server's other users' names to the person inviting.

## Devices and transferring playback

Each user has **one** playback session, held by the server: the queue, the current track and position, shuffle and repeat, and which device is playing. Every signed-in browser tab and phone is a device in that session.

- **One device plays; every other one is a remote.** Open the web app while your phone plays and you see the same track at the same position, with the controls driving the phone. The player highlights the device button, which opens the list of outputs and transfer controls.
- **Pressing play when nothing is playing** makes the device you pressed it on the player.
- **Transferring.** Open the devices list (the **Devices** button in the player bar on the web; on iOS, the playback device button in the mini-player or Now Playing, which opens the **Playback device** sheet) and pick a device. Playback continues there from the same position. Each device keeps its own volume.
- **A browser is one device; its tabs are players of it.** Each tab of a browser can play, one at a time, so a second tab joins the session on its own, but lists show the browser once, under its name (the playing tab, else the first one). Inside the browser, its other tabs appear as one **Another tab** row, and "Playing in another tab" says where the sound is. No list shows a tab number. Rename the browser in **Settings → Playback → This browser's name**.
- **When the playing device disappears**, the other devices' clocks stop where it was and their device pickers show **Reconnecting to …**. You can select a different device or take over from the current device. If it comes back within 20 seconds (a dropped connection) it carries on; otherwise the server pauses the session at that position. Any device can resume it.
- **Playing separately.** One device can step out of the session and play its own queue while the others play something else, and rejoin later: in the web app, **Devices → Play separately on this tab** ([how it looks](../use/web.md#playing-separately-on-one-device)), and on iOS, **Playback device → Play separately on this iPhone** ([iOS](../use/ios.md#playing-separately-on-one-device)).
- **Telling devices apart.** The device you are using is **This browser** (or **This iPhone**). Others are named after their browser and system ("Chrome on macOS", "Safari on iPad") until you rename them. Two browsers can still have the same name: then each shows the start of its id, such as "ID 4f2a". Renaming one is the lasting fix. (Older servers listed devices that had gone quiet, with how long ago they were last active, such as "Active 3 hours ago".)
- **A device is listed only while it is open and responding.** The server checks every device every five seconds; one that stops answering (a laptop asleep, a phone out of signal) drops off the list within 15 seconds, and a tab you close, or a page the browser freezes, at once. A tab that is only in the background stays listed: it still answers and can play. The iPhone app leaves the list as soon as it goes to the background with nothing playing, since iOS is about to suspend it, and is back when you open it; while it plays in the background it stays listed. Because every listed device is responding, none is shown as "Active … ago".

Browsers may refuse to start audio until you have clicked on the page. When that happens after a transfer or a reload, the web app's player shows **Play**, and a notice says "Your browser is holding back audio" with **Enable audio**; either starts it.

### Gapless playback

The playing device loads the next track before the current one ends. In the web app the measured gap between tracks is a few milliseconds. On iOS the next track starts as the previous one ends, which is close to gapless but not sample-accurate: a continuous live album can have a tiny audible seam.

## What "preparing" means

A track playable on demand through an [acquisition provider](./acquisition.md) whose file is still being fetched shows the player's buffering spinner (the web app says **Still loading…** after eight seconds). The session waits at the start of the track and begins as soon as the file arrives. The server starts fetching the next five tracks in the queue ahead of time. If the provider doesn't have the track, it is skipped with a light notice ("not available"), stays gray for a day, and playback goes on; the track you started yourself is not skipped: playback stays on it, paused, and says it could not play. An upcoming track that fails is skipped, and told, when reached, and when nothing left in the queue is available playback stops and says so. After five different tracks in a row are unavailable with nothing delivered in between, playback pauses instead of skipping on. If fetching is down (the provider is failing or can't be reached), playback pauses at the first track that fails, with a notice that says why. Other failures are skipped too, but after three in a row playback pauses instead of skipping through the queue.

On a server without acquisition providers, nothing is ever preparing.
