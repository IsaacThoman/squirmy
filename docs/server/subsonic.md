# Subsonic clients

Squirmy speaks the [OpenSubsonic](https://opensubsonic.netlify.app/) API, so apps written for Subsonic, Navidrome and similar servers can play your library. This is also the way to use Squirmy on Android today. The API lives under `/rest` on the same address as the web app.

The API was tested against py-opensonic, py-sonic, subsonic-api (Node) and the Airsonic Refix web client. Other apps (Symfonium, Amperfy, play:Sub, Substreamer, DSub, Feishin, Supersonic and so on) speak the same API but have not been tried; reports are welcome.

Subsonic apps see **your library only**, and only the parts of it with a file on the server, because these apps sync their lists and expect to play anything in them at once. Your library is what you hearted (starred) and uploaded, plus the server's collection if you turn on **Show all of this server’s music in your library** in the web app's **Settings → Library**:

- **Albums**: the albums you added to your library in Squirmy (your uploads included), once at least one of their songs has a file, and with the setting on the server's collection (music scanned from your folders, uploaded or imported). An album you added shows only the songs that have arrived so far.
- **Songs**: the songs you added and the songs of albums you added, when they have a file, and with the setting on the collection's.
- **Artists**: those credited on the albums or songs above.

Music the server fetched only because someone played it is not in anyone's library, so it stays out of albums, artists, search, random songs and genres. Once your server streams through a provider, Subsonic apps therefore show fewer albums than they used to: your library, not everything that was ever played. Add an album to your library in Squirmy's web or phone app to see it in Subsonic apps too. Each person sees their own additions; the collection is shared, and searching with a query finds all of it.

Starred songs and playlists are your own picks, so they show every song with a file on the server, whether or not it is in your library; starred albums and artists show only when they are in it. A song that has a file can always be streamed by its id.

## Connect an app

1. In Squirmy's web app, open **Settings → App passwords** and choose **Create** (the iOS app doesn't make app passwords). Name it after the app ("Symfonium on my phone"), enter your account password, and choose **Create**.
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

- **Stars are the heart.** Starring a song, album or artist in an app saves it to your Squirmy library, and the other way round: a song you heart in Squirmy is starred in the app.
- **Ratings** (1 to 5 stars) are kept for Subsonic apps; Squirmy's own apps do not show them.
- **Scrobbles are plays.** A scrobble adds the play to your history at the time the app reports, and from there to ListenBrainz or Last.fm when you have connected them. A "now playing" notice shows in `getNowPlaying` until the song would have ended.
- **The play queue is your Squirmy queue.** Save the queue in one app and Squirmy's web and phone apps pick it up paused at the same point, and the other way round. Tracks a Subsonic app saved before its current song are remembered until the queue changes in Squirmy. Of a very long queue, 5,000 tracks from the current song on, and 5,000 before it, are kept.
- **Music folders are library roots.** Apps that filter by folder see one folder per root.
- **Your library is Squirmy's library**, what you saved (plus the music on the server with the setting on), limited to songs whose files are on the server: an album you starred shows once its files have arrived. A search with a query, and opening an album or artist by id, also reach the server's collection, so search finds everything the server has.
- **Similar songs and artists** come from Squirmy's radio, limited to your library.
- **ReplayGain** values on songs are Squirmy's loudness measurements (or the file's own tags until a file is measured), relative to -18 LUFS.
- **Song metadata** includes role-based `contributors` and `displayComposer`, plus `works` and `movements` when available. `explicitStatus` is `explicit`, `clean` or an empty string when unknown. File comments are available as `comment`.

### Streaming and transcoding

By default an app gets the original file, with byte ranges, so seeking works.

- `maxBitRate` caps the bitrate. A file above it is transcoded to MP3 at 320 or 192 kbps; lower caps are encoded live at that bitrate.
- `format=mp3`, `opus` (or `ogg`) and `aac` (or `m4a`) pick the codec. `format=raw` always sends the original.
- Transcodes at the standard bitrates are cached, so the second play seeks like an original. Live encodes (below 192 kbps, or from a `timeOffset`) are not cached.
- Live encodes share the server's encoders with the other transcodes (at most half the CPU cores, at least two) and do not wait for one: when all are busy, `stream` answers a Subsonic error (code 0) asking to try again shortly. One user runs at most three live encodes at a time.
- `timeOffset` starts a transcode that many seconds in, for apps that seek while transcoding.
- `estimateContentLength=true` sends a Content-Length for transcodes, estimated from the duration and bitrate.

Cover art is served at the original size, or with `size` as a square WebP at the nearest of 96, 300, 600 and 1200 pixels at or above the request.

A cover that cannot be served right now (its download failed within the last hour, or its file is gone and cannot be rebuilt) is left out of `coverArt` and the image URLs rather than handed out to fail. A song then shows its file's embedded picture if it has one.

## What does not

- **Podcasts, internet radio, bookmarks, shares, jukebox, chat and video.** Squirmy has none of these. `getPodcasts`, `getNewestPodcasts`, `getInternetRadioStations`, `getBookmarks` and `getShares` answer with empty lists so apps that ask at startup are content; the rest answer with an error.
- **User management** (`getUsers`, `createUser`, `updateUser`, `deleteUser`, `changePassword`). Manage accounts and passwords in Squirmy's admin settings.
- **Downloading a whole album or artist** with `download`. Download songs one by one, or let the app do it.
- **The `transcoding` extension** (`getTranscodeDecision`), **`playbackReport`**, **`sonicSimilarity`** and the karaoke timing of `songLyrics` version 2.
- **Album and artist sort names, moods, BPM, comments and contributors** are not stored, so songs do not carry them.
- **Playlist limits** are the web app's: names up to 120 characters, comments up to 2,000, 10,000 songs per playlist and 1,000 playlists per person. An app that goes past one gets an error, and the songs stay as they were.
- **Clearing the play queue** from an app keeps the current song: a Squirmy session always has something it is on.

## For developers

The module is `apps/server/src/modules/subsonic`. `handlers/` has one file per area of the API, named in the table above; `songs.ts`, `albums.ts` and `artists.ts` build the response objects in batches. Ids carry their kind: `ar-` artist, `al-` album, `tr-` track, `pl-` playlist, `ca-` cover art. Tests run every method in XML and JSON and compare the two; `SQUIRMY_PERF=1 npx vitest run src/modules/subsonic/performance.test.ts` times the paging methods on 150,000 tracks, and `stubs-performance.test.ts` on a catalog of 200,000 search stubs around a small library.
