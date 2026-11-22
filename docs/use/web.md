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

- **Home** shows a featured album (what you played last, else what you added last) and the rows the server sends, in its order: what you played recently and most, your playlists, what you added to your library, liked albums, new releases by artists you have or like, and your [wantlist](./wantlist.md) (when it is turned on). With nothing to show yet it says how to start: **Find music** opens the search page when the server can fetch music for you, and admins get **Add a music folder**, which opens **Admin → Library**.
- **Albums**, **Artists** and **Songs** are sections of the **Library** page, with **Playlists** beside them in its bar. They hold [your library](#your-library), load as you scroll, and albums and songs can be sorted and filtered by genre (artists are listed by name). Counts read "60+" until the last page arrives.
- **Album, artist and playlist pages** play from the header. Artist pages list each release once, a row per kind (Albums, Mixtapes, EPs, Singles, Live albums, Compilations, Soundtracks), with releases by other artists that feature them under **Appears on**; **See all** opens every release of a row. Under the artist's name is what tells them apart from others of that name ("1960s British band"). A big artist opened for the first time shows its releases at once and says **Loading discography…** while the rest comes in. They can start a radio when something by the artist plays for you (for someone who may fetch music, that includes what the server can fetch). An album page shows its cover, title and artist at once; when the server is still looking up its songs, the list fills in a moment later, and **Play** can be pressed already.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted. A playlist holds up to 10,000 songs, and you can have up to 1,000 playlists.

## Search

**Search** in the sidebar opens the search page, with the search field in the bar at its top. Results come as you type, as one list: the **Top result**, then **Artists**, **Albums** and **Songs**. It covers all music, not only what is on your server:

- What you have and play yourself comes first in each list, and shows at once. Results from the server's catalog search (Deezer by default, or the [local search index](../server/metadata-and-privacy.md#the-local-search-index)) join below it a moment later, so nothing you are looking at moves.
- **Top result** is the best match for what you typed: click it to open it, or play it with its play button. **Enter** in the search field plays it (an album or a song) or opens it (an artist).
- Music that plays looks the same whether its file is on your server or not. What you cannot play is gray, comes last in its list and says **Not available**; when your server has the Wantlist turned on, you can bookmark it to your [wantlist](./wantlist.md).
- While you type on, the results of what you typed so far stay up, faded, until the new ones arrive.

Before you type, the page shows browse-by-genre tiles, which open your albums filtered to that genre.

### Quick search

Ctrl+K (⌘K on a Mac) opens a search box over whatever page you are on. It searches as you type, with the same results as the search page, the best match first.

- Move through the results with ↑ and ↓ and press Enter, or click one. An artist or an album opens; a song plays. A song that cannot be played opens its album instead.
- The last row, **See all results for "…"**, opens the search page with what you typed.
- With nothing typed, the box lists places to go: the pages of the sidebar, **Playlists**, **Liked Songs** and, for admins, **Admin panel**.
- Escape closes it.

## Playing music

Click a song, or the play button on an album or playlist. The player bar along the bottom has the transport, the seek bar, volume, **Save to Liked Songs**, **Lyrics**, **Queue** and **Devices**. **Queue** opens the queue in a panel beside the page; in a narrower window the panel floats over the page's right side. Click the artwork in the bar, or **Now Playing** at its right end, to open **Now Playing**, full screen, with lyrics (synced lyrics follow the song, and clicking a line jumps to it) or the queue beside the artwork.

On a phone the player is a small bar at the bottom with the song, **Devices** and play or pause. Tap it for **Now Playing**, which is where the queue and the lyrics are.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Add to library** or **Remove from library** (songs stored on the server, and songs of an album you added, have neither: they stay in your library), **Go to album**, **Go to** each of its artists, and **Add to Wantlist** for music that is not available (when the Wantlist is turned on). You can also drag songs onto a playlist, or onto Liked Songs, in the sidebar.
- **Queue**: reorder by dragging, or focus a song's handle and use the arrow keys; remove songs; **Clear** the queue or the history. The queue holds up to 10,000 songs; adding more than fit does nothing. **Autoplay** keeps music going with similar songs from your library when the queue runs out.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).

## Your library

Your library is the music on your server (what its owner scanned, uploaded or dropped in the inbox, shared by everyone) plus what you added. Only you add to it: playing, liking or downloading music never does.

- **Add to library** is the plus in an album's header, in album and song menus, and beside the heart in **Now Playing**. It turns into a check at once and a notice offers **Undo**; the server fetches anything it does not have yet behind it, and the album is in **Library → Albums** straight away. **Remove from library** takes it out again; your likes, playlists and history keep it.
- Albums on your server show a check, **On this server**, with nothing to remove: they are in everyone's library.
- Liking is separate: a heart puts a song in **Liked Songs** (or an album among your liked albums) and does not add it to the library.

An empty library says what it holds and how to add to it, with **Find music**.

## Music that is not on the server yet

With an [acquisition provider](../server/acquisition.md) connected, the server fetches music when someone who may fetch plays it: admins, and members an admin allowed to. For them it works like any streaming app, and nothing in the app says where a song's file is:

- Play anything. While the song is on its way, the play button and its row show the spinner the player uses for buffering, and the artist stays under the title. If it takes longer than eight seconds, the player says **Still loading…** instead.
- The server fetches the playing song and the next five ahead of time. Songs waiting in the queue look like any other.
- A song the server can't get is told once, when it was playing or next ("Couldn't play "…"", **Skipped.**), turns gray with **Not available**, and playback moves on. Failures further down the queue are quiet. If three songs in a row can't be loaded, playback pauses instead of skipping on, with one notice, **Can't load music right now**; press play to try again. When the server knows its source is down, it pauses at the first song and the notice says so.

For members who may not fetch, and on servers without a provider, music that is not on the server is gray and says **Not available**; an album that is partly there says how many of its songs are available.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it into the library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

## Devices

Every open tab is a device in your one playback session. When music plays somewhere else, the player bar says "Playing on …" with **Play here**; the controls drive that device and this tab plays nothing. **Devices** lists where you can play, including **Play in this tab**. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

### Playing separately on one device

To have one tab play its own music while your other devices play something else (two people on one account, or two rooms), open **Devices** and choose **Play separately on this tab**. It happens at once: if this tab was playing it carries on and your other devices pause where they were; otherwise it starts from a paused copy of the queue. While it plays separately the player bar and Now Playing say **Only on this device**; press it to open **Devices** again, which then offers:

- **Rejoin your other devices**: this tab stops, drops its own queue and shows what the others play.
- **Bring this queue with me**: this tab keeps playing, and your other devices switch to its queue.

Other devices list a tab like this under **Playing separately**, with the song it plays, and playback can't be moved to it. Playing separately survives a reload; after a week away it plays with your other devices again. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

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

- **A history page.** Recent listening is under **History** in the queue panel and in Home's "Recently played".

See [keyboard shortcuts](./keyboard-shortcuts.md).
