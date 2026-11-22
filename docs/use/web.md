# The web app

The web app is served by your Squirmy server at its own address, such as `https://music.example.com`. Sign in, and it is your library, a player, and (for admins) the server's admin panel. This page is a short tour.

## Getting around

The sidebar has **Home**, **Search**, **Albums**, **Artists**, **Songs**, the **Wantlist** (when your server has the Wantlist turned on) and **Add music** (for admins and people who may upload). Below them are your **Playlists**, with **Liked Songs** first. **New playlist** (the **+** next to Playlists) makes one, and the **Playlists** heading opens the page with all of them. Right-click a playlist to **Play** it.

The button with your name, at the foot of the sidebar, opens the account menu: **Settings**, **Admin panel** (for admins) and **Log out**.

The sidebar changes shape, and this browser remembers how you left it:

- **Fold it** to a rail of icons with **Close sidebar**, the button at its top. The rail keeps the pages and the account menu and hides the playlists. The logo at the top of the rail opens it again (**Open sidebar**). Ctrl+B (⌘B on a Mac) does both.
- **Resize it** by dragging its right edge. Dragging far enough to the left folds it, and a double click on the edge brings back the default width.
- **On a phone**, or in a window narrower than 768 pixels, the sidebar is a drawer. Open it with the button at the top left of the page. It closes when you pick something, tap outside it or press Escape.

Most pages have a bar across the top with the page's name and, on some, links to its sections and controls such as sorting. The bar stays in place while the page scrolls. Album, artist and playlist pages and Liked Songs start with their artwork instead.

- **Home** shows a featured album (what you played last, else what was added last) and rows of recently added and recently played albums, most played songs, your playlists, liked albums, your [wantlist](./wantlist.md) (when it is turned on) and new releases by artists in your library. On a server with no music yet it says so; admins get **Add a music folder**, which opens **Admin → Library**.
- **Library** is the music on your server (scanned, uploaded or dropped in the inbox) plus what you added to it. Songs the server fetched only because you played them are not added, so sampling something never fills your library. **Albums**, **Artists** and **Songs** are sections of the **Library** page, with **Playlists** beside them in its bar. They load as you scroll and can be sorted and filtered by genre. Counts read "60+" until the last page arrives.
- **Album, artist and playlist pages** play from the header. Artist pages can start a radio. The first open of an artist the server knows little about can take a few seconds while it fetches the details.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted. A playlist holds up to 10,000 songs, and you can have up to 1,000 playlists.

## Search

**Search** in the sidebar opens the search page, with the search field in the bar at its top. Two searches run at once:

- **Top result** leads when an artist, album or song is named the way you typed it (or starts with it): click it to open it, or play it with its play button when it is on your server. Your library's best match comes before the catalog's.
- **In your library** comes next, at full brightness, and tolerates typos and word order.
- **More to discover** comes below, in gray, from the server's catalog search (Deezer by default, or the [local search index](../server/metadata-and-privacy.md#the-local-search-index)). Gray albums and songs are not on your server. When your server has the Wantlist turned on, you can bookmark them to your [wantlist](./wantlist.md).

Each group lists artists, then albums, then songs.

Before you type, the page shows browse-by-genre tiles, which open your albums filtered to that genre.

### Quick search

Ctrl+K (⌘K on a Mac) opens a search box over whatever page you are on. It searches your library as you type.

- Move through the results with ↑ and ↓ and press Enter, or click one. An artist or an album opens; a song plays. A song that cannot be played opens its album instead.
- The last row, **Search everything for "…"**, opens the search page with what you typed, which also covers music you do not have.
- With nothing typed, the box lists places to go: the pages of the sidebar, **Playlists**, **Liked Songs** and, for admins, **Admin panel**.
- Escape closes it.

## Playing music

Click a song, or the play button on an album or playlist. The player bar along the bottom has the transport, the seek bar, volume, **Save to Liked Songs**, **Lyrics**, **Queue** and **Devices**. **Queue** opens the queue in a panel beside the page; in a narrower window the panel floats over the page's right side. Click the artwork in the bar, or **Now Playing** at its right end, to open **Now Playing**, full screen, with lyrics (synced lyrics follow the song, and clicking a line jumps to it) or the queue beside the artwork.

On a phone the player is a small bar at the bottom with the song, **Devices** and play or pause. Tap it for **Now Playing**, which is where the queue and the lyrics are.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Go to album**, and **Add to Wantlist** for music you do not have (when the Wantlist is turned on). You can also drag songs onto a playlist, or onto Liked Songs, in the sidebar.
- **Queue**: reorder by dragging, or focus a song's handle and use the arrow keys; remove songs; **Clear** the queue or the history. The queue holds up to 10,000 songs; adding more than fit does nothing. **Autoplay** keeps music going with similar songs from your library when the queue runs out.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).

## Music the server does not have

With an [acquisition provider](../server/acquisition.md) connected, gray songs it can supply show a cloud icon, "Plays on demand". Play one and it shows **Preparing…** until the file arrives, then plays. The server fetches the playing song and the next five ahead of time; in the queue, those say **Preparing…** and songs further down keep the cloud icon until their turn comes; an album page offers **Get this album**. If a fetch fails, a notice says so and the song is skipped. If three songs in a row can't be loaded, playback pauses on the third instead of skipping on; press play to try the next one. Without permission to fetch music, those songs stay gray, and their row says to ask an admin.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it into the library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

## Devices

Every open tab is a device in your one playback session. When music plays somewhere else, the player bar says "Playing on …" with **Play here**; the controls drive that device and this tab plays nothing. **Devices** lists where you can play, including **Play in this tab**. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

If the browser refuses to start audio on its own (after a transfer or a reload), a notice says "Your browser is holding back audio"; choose **Enable audio**. "Reconnecting to the server…" means the live connection dropped; it comes back by itself, and behind a proxy it usually means WebSockets are not passed through.

## Settings

**Settings** opens as a dialog over the page you are on. Choose it in the account menu, or press Ctrl+, (⌘, on a Mac). Its sections:

- **Playback**: the settings listed under [Playing music](#playing-music).
- **Appearance**: light or dark, and the color theme. See [Appearance and themes](#appearance-and-themes).
- **Account**: **Edit name** (for admins), **Change password** and **Log out**.
- **Scrobbling**: [ListenBrainz and Last.fm](../server/scrobbling.md).
- **App passwords** for [Subsonic apps](../server/subsonic.md).
- **About**: the server's name, version and address, and the main [keyboard shortcuts](./keyboard-shortcuts.md).

Each section has an address that opens the dialog on it, such as `/settings/appearance`.

## Appearance and themes

**Settings → Appearance** has two choices:

- **Theme**: **Light**, **Dark** or **System**, which follows your device between light and dark.
- **Color theme**: **Squirmy** (the default: soft violet with a berry accent), **Pulpo** (neutral grays), **Ocean** (blue), **Forest** (green) or **Ember** (orange). Each has light and dark colors, and its preview shows the ones in use now.

Both apply at once. They are kept in this browser, not in your account, so each browser and device has its own.

## Admin

Admins manage the server in the admin panel: choose **Admin panel** in the account menu, or under the sections of **Settings** (not on a phone). The bar at its top, titled **Admin**, links to the sections, and each has its own guide. The guides name them like **Admin → Library**.

| Section | Guide |
|---|---|
| **Library** | [Your library](../server/library.md) |
| **Review queue** | [The review queue and Fix match](../server/library.md#the-review-queue-and-fix-match) |
| **Organize** | [Organizing files](../server/organizing.md) |
| **Search index** | [The local search index](../server/metadata-and-privacy.md#the-local-search-index) |
| **Providers** | [Acquisition providers](../server/acquisition.md) |
| **Users & invites** | [Users and access](../server/users.md) |
| **Server settings** | [Configuration](../server/configuration.md#server-settings) |
| **Jobs** | [Troubleshooting](../server/troubleshooting.md#logs-and-the-jobs-page) |

The server's version is at the bottom of each admin page, in **Settings → About**, and on the sign-in page.

## Not there yet

- **Full pages for music you do not own.** Opening a gray album or artist shows what the catalog knows, which can be thin until its details are fetched.
- **A history page.** Recent listening is under **History** in the queue panel and in Home's "Recently played".

See [keyboard shortcuts](./keyboard-shortcuts.md).
