# Subsonic clients

Squirmy speaks the [OpenSubsonic](https://opensubsonic.netlify.app/) API, so apps written for Subsonic, Navidrome and similar servers can play your library. This is also the way to use Squirmy on Android today. The API lives under `/rest` on the same address as the web app.

The API was tested against py-opensonic, py-sonic, subsonic-api (Node) and the Airsonic Refix web client. Other apps (Symfonium, Amperfy, play:Sub, Substreamer, DSub, Feishin, Supersonic and so on) speak the same API but have not been tried; reports are welcome.

Subsonic apps see **your library only**: albums with at least one file on the server, the tracks you have files for, and their artists. Music Squirmy knows about but you do not own never appears, and a playlist shows only the tracks the server can play.

## Connect an app

1. In Squirmy, open **Settings → App passwords** and choose **Create**. Name it after the app ("Symfonium on my phone"), enter your account password, and choose **Create**.
2. Copy the password. It is shown once.
3. In the app, add a Subsonic (or OpenSubsonic, or Navidrome) server:
   - **Server address**: the address you open Squirmy at, such as `https://music.example.com`. Do not add `/rest`.
   - **Username**: your Squirmy username.
   - **Password**: the app password. Your account password does not work here, on purpose.
4. Apps that support **API keys** can use the app password as the key, with no username.

Give each app its own app password. Settings shows when each was last used; revoke one to sign that app out without touching the others or your account. Changing your account password, or an admin resetting or disabling it, deletes your app passwords: create new ones for your apps afterwards.

Use HTTPS when the server is reachable from the internet. Older Subsonic apps send the password, or a hash of it, in the URL of every request.

### Check the connection yourself

If an app cannot connect, try the same credentials with `curl`:

```sh
curl "https://music.example.com/rest/ping?u=YOUR_USERNAME&p=YOUR_APP_PASSWORD&v=1.16.1&c=test&f=json"
```

A working server and password answer `"status":"ok"`. A wrong password answers `"status":"failed"` with an error code; repeated failures from one address are rate limited for a minute.

## What works

| Area | Methods |
| --- | --- |
| System | `ping`, `getLicense`, `getOpenSubsonicExtensions`, `tokenInfo`, `getUser`, `getScanStatus`, `startScan` (admins) |
| Browsing by tags | `getMusicFolders`, `getArtists`, `getArtist`, `getAlbum`, `getSong`, `getGenres`, `getArtistInfo`, `getArtistInfo2`, `getAlbumInfo`, `getAlbumInfo2`, `getTopSongs`, `getSimilarSongs`, `getSimilarSongs2` |
| Browsing by folders | `getIndexes`, `getMusicDirectory`: artist, then album, then songs |
| Lists | `getAlbumList` and `getAlbumList2` (every type), `getRandomSongs`, `getSongsByGenre`, `getStarred`, `getStarred2`, `getNowPlaying` |
| Search | `search2`, `search3`, ranked like the search in Squirmy's apps and tolerant of typos; an empty query returns everything, for apps that sync the library |
| Media | `stream`, `download`, `getCoverArt`, `getLyrics`, `getLyricsBySongId` |
| Stars, ratings, plays | `star`, `unstar`, `setRating`, `scrobble` |
| Playlists | `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`, `deletePlaylist` |
| Play queue | `getPlayQueue`, `savePlayQueue`, `getPlayQueueByIndex`, `savePlayQueueByIndex` |

OpenSubsonic extensions: `apiKeyAuthentication`, `formPost`, `songLyrics` (synced lyrics), `transcodeOffset` (seeking while transcoding), `indexBasedQueue` and `topSongsByArtistId`.

Requests can be GET or form POST, with or without `.view`, and answers come as XML (the default), JSON or JSONP.

### How it maps onto Squirmy

- **Stars are likes.** Starring a song, album or artist in an app likes it in Squirmy, and the other way round.
- **Ratings** (1 to 5 stars) are kept for Subsonic apps; Squirmy's own apps do not show them.
- **Scrobbles are plays.** A scrobble adds the play to your history at the time the app reports, and from there to ListenBrainz or Last.fm when you have connected them. A "now playing" notice shows in `getNowPlaying` until the song would have ended.
- **The play queue is your Squirmy queue.** Save the queue in one app and Squirmy's web and phone apps pick it up paused at the same point, and the other way round. Tracks a Subsonic app saved before its current song are remembered until the queue changes in Squirmy.
- **Music folders are library roots.** Apps that filter by folder see one folder per root.
- **Similar songs and artists** come from Squirmy's radio, limited to music you own.
- **ReplayGain** values on songs are Squirmy's loudness measurements (or the file's own tags until a file is measured), relative to -18 LUFS.

### Streaming and transcoding

By default an app gets the original file, with byte ranges, so seeking works.

- `maxBitRate` caps the bitrate. A file above it is transcoded to MP3 at 320 or 192 kbps; lower caps are encoded live at that bitrate.
- `format=mp3`, `opus` (or `ogg`) and `aac` (or `m4a`) pick the codec. `format=raw` always sends the original.
- Transcodes at the standard bitrates are cached, so the second play seeks like an original. Live encodes (below 192 kbps, or from a `timeOffset`) are not cached.
- `timeOffset` starts a transcode that many seconds in, for apps that seek while transcoding.
- `estimateContentLength=true` sends a Content-Length for transcodes, estimated from the duration and bitrate.

Cover art is served at the original size, or with `size` as a square WebP at the nearest of 96, 300, 600 and 1200 pixels at or above the request.

## What does not

- **Podcasts, internet radio, bookmarks, shares, jukebox, chat and video.** Squirmy has none of these. `getPodcasts`, `getNewestPodcasts`, `getInternetRadioStations`, `getBookmarks` and `getShares` answer with empty lists so apps that ask at startup are content; the rest answer with an error.
- **User management** (`getUsers`, `createUser`, `updateUser`, `deleteUser`, `changePassword`). Manage accounts and passwords in Squirmy's admin settings.
- **Downloading a whole album or artist** with `download`. Download songs one by one, or let the app do it.
- **The `transcoding` extension** (`getTranscodeDecision`), **`playbackReport`**, **`sonicSimilarity`** and the karaoke timing of `songLyrics` version 2.
- **Album and artist sort names, moods, BPM, comments and contributors** are not stored, so songs do not carry them.
- **Clearing the play queue** from an app keeps the current song: a Squirmy session always has something it is on.

## For developers

The module is `apps/server/src/modules/subsonic`. `handlers/` has one file per area of the API, named in the table above; `songs.ts`, `albums.ts` and `artists.ts` build the response objects in batches. Ids carry their kind: `ar-` artist, `al-` album, `tr-` track, `pl-` playlist, `ca-` cover art. Tests run every method in XML and JSON and compare the two; `SQUIRMY_PERF=1 npx vitest run src/modules/subsonic/performance.test.ts` times the paging methods on 150,000 tracks.
