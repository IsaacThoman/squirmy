# The web app

The web app is served by your Squirmy server at its own address, such as `https://music.example.com`. Sign in, and it is your library, a player, and (for admins) the server's admin pages. This page is a short tour.

## Getting around

The sidebar has **Home**, **Search**, your **Library** (**Albums**, **Artists**, **Songs**), the **Wantlist**, **Add music** (for admins and people who may upload), and your **Playlists** with **Liked Songs** at the top. **New playlist** (the **+** next to Playlists) makes one. Admins also see **Admin**.

The menu under your name, top right, has **Settings**, **Add music** (for people who may upload), **Admin** (for admins) and **Log out**.

- **Home** shows a featured album (what you played last, else what was added last) and rows of recently added and recently played albums, most played songs, your playlists, liked albums, your wantlist and new releases by artists in your library. On a server with no music yet it says so; admins get **Add a music folder**, which opens **Admin → Library**.
- **Library** is the music on your server (scanned, uploaded or dropped in the inbox) plus what you added to it. Songs the server fetched only because you played them are not added, so sampling something never fills your library. Library pages load as you scroll and can be sorted and filtered by genre. Counts read "60+" until the last page arrives.
- **Album, artist and playlist pages** play from the header. Artist pages can start a radio. The first open of an artist the server knows little about can take a few seconds while it fetches the details.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted.

## Search

Type in **Search** (or the search field at the top). Two searches run at once:

- **Top result** leads when an artist, album or song is named the way you typed it (or starts with it): click it to open it, or play it with its play button when it is on your server. Your library's best match comes before the catalog's.
- **Your library** comes next, at full brightness, and tolerates typos and word order.
- **Everything else** comes below, in gray, from the server's catalog search (Deezer by default, or the [local search index](../server/metadata-and-privacy.md#the-local-search-index)). Gray albums and songs are not on your server; bookmark them to your [wantlist](./wantlist.md).

Each group lists artists, then albums, then songs.

Browse-by-genre tiles open your library filtered to that genre.

## Playing music

Click a song, or the play button on an album or playlist. The player bar at the bottom has the transport, the seek bar, volume, **Save to Liked Songs**, **Lyrics**, **Queue** and **Devices**. Click the track to open **Now Playing**, full screen, with lyrics (synced lyrics follow the song, and clicking a line jumps to it) or the queue beside the artwork.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Go to album**, and **Add to Wantlist** for music you do not have. You can also drag songs onto a playlist, or onto Liked Songs, in the sidebar.
- **Queue**: reorder by dragging, or focus a song's handle and use the arrow keys; remove songs; **Clear** the queue or the history. **Autoplay** keeps music going with similar songs from your library when the queue runs out.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).

## Music the server does not have

With an [acquisition provider](../server/acquisition.md) connected, gray songs it can supply show a cloud icon, "Plays on demand". Play one and it shows **Preparing…** until the file arrives, then plays. The server fetches the playing song and the next two ahead of time; in the queue, those say **Preparing…** and songs further down keep the cloud icon until their turn comes; an album page offers **Get this album**. If a fetch fails, a notice says so and the song is skipped. Without permission to fetch music, those songs stay gray, and their row says to ask an admin.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it into the library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

## Devices

Every open tab is a device in your one playback session. When music plays somewhere else, the player bar says "Playing on …" with **Play here**; the controls drive that device and this tab plays nothing. **Devices** lists where you can play, including **Play in this tab**. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

If the browser refuses to start audio on its own (after a transfer or a reload), a notice says "Your browser is holding back audio"; choose **Enable audio**. "Reconnecting to the server…" means the live connection dropped; it comes back by itself, and behind a proxy it usually means WebSockets are not passed through.

## Settings

**Settings** also holds **Scrobbling** ([ListenBrainz and Last.fm](../server/scrobbling.md)), **App passwords** for [Subsonic apps](../server/subsonic.md), and **Account**: **Edit name**, **Change password** and **Log out**.

## Admin

Admins manage the server here. Each page has its own guide:

| Page | Guide |
|---|---|
| **Library** | [Your library](../server/library.md) |
| **Review queue** | [The review queue and Fix match](../server/library.md#the-review-queue-and-fix-match) |
| **Organize** | [Organizing files](../server/organizing.md) |
| **Search index** | [The local search index](../server/metadata-and-privacy.md#the-local-search-index) |
| **Providers** | [Acquisition providers](../server/acquisition.md) |
| **Users & invites** | [Users and access](../server/users.md) |
| **Server settings** | [Configuration](../server/configuration.md#server-settings) |
| **Jobs** | [Troubleshooting](../server/troubleshooting.md#logs-and-the-jobs-page) |

The server's version is under the admin sections (at the bottom of the page on a phone) and on the sign-in page.

## Not there yet

- **Full pages for music you do not own.** Opening a gray album or artist shows what the catalog knows, which can be thin until its details are fetched.
- **A history page.** Recent listening is under **History** at the top of the queue panel and in Home's "Recently played".

See [keyboard shortcuts](./keyboard-shortcuts.md).
