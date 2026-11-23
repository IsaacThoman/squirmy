# The web app

The web app is served by your Squirmy server at its own address, such as `https://music.example.com`. Sign in, and it is your library, a player, and (for admins) the server's admin panel. This page is a short tour.

To open it like an app, install it from your browser (**Install** in Chrome or Edge, **Add to Dock** in Safari on a Mac, **Add to Home Screen** on a phone). It opens in a window of its own, with the Squirmy icon.

## Getting around

The sidebar has **Home**, **Search**, **Library**, the **Wantlist** (when your server has the Wantlist turned on) and **Add music** (for admins and people who may upload). Below them are your **Playlists**, with **Liked Songs** first. **New playlist** (the **+** next to Playlists) makes one, and the **Playlists** heading opens the page with all of them. Right-click a playlist to **Play** it.

The button with your name, at the foot of the sidebar, opens the account menu: **Settings**, **Admin panel** (for admins) and **Log out**.

The sidebar changes shape, and this browser remembers how you left it:

- **Fold it** to a rail of icons with **Close sidebar**, the button at its top. The rail keeps the pages, Liked Songs and your playlists (as their covers, named when you point at them) and the account menu. The logo at the top of the rail opens it again (**Open sidebar**). Ctrl+B (⌘B on a Mac) does both.
- **Resize it** by dragging its right edge. Dragging far enough to the left folds it, and a double click on the edge brings back the default width.
- **On a phone**, or in a window narrower than 768 pixels, the sidebar is a drawer. Open it with the button at the top left of the page. It closes when you pick something, tap outside it or press Escape.

Most pages have a bar across the top with the page's name and, on some, links to its sections and controls such as sorting. The bar stays in place while the page scrolls. **Back** and **Forward** return to where each page was scrolled, and each row that scrolls sideways (such as Home's **Recently played**) to where it was; a link opens its page at the top. Album, artist and playlist pages and Liked Songs start with their artwork instead.

- **Home** shows a featured album (what you played last, else what you added last) and the rows the server sends, in its order: what you played recently and most, your playlists, what you saved to your library, new releases by artists you have or like, and your [wantlist](./wantlist.md) (when it is turned on). With nothing to show yet it says how to start: **Find music** opens the search page when the server can fetch music for you, and admins get **Add a music folder**, which opens **Admin → Library**.
- **Library** is one page holding [your library](#your-library), as on the phone. Chips across the top choose what it shows: **All** (Liked Songs first, then your playlists, then albums), **Playlists**, **Albums**, **Artists** or **Songs**. On a phone they wrap under the page's title. Sort albums by **Recently added**, **Title**, **Artist** or **Year** (songs by the first three; artists are listed by name; under **All** the sort orders the albums, after Liked Songs and the playlists), switch between a grid and a list, and use **Find in your library** to search it. A genre chosen in Search stays on **All**, **Albums** and **Songs** (songs from albums of that genre) until you remove it. If albums, artists or songs fail to load, the page says so where they would be, with **Try again**, and keeps the chips and whatever else loaded. An album none of whose songs would play for you says **Not available** under its title. The page remembers the chip and the layout you chose in this browser, and loads more as you scroll. Old links to the Albums, Artists, Songs and Playlists pages open Library on that chip.
- **Album, artist and playlist pages** play from the header. Artist pages list each release once, a row per kind (Albums, Mixtapes, EPs, Singles, Live albums, Compilations, Soundtracks), with releases by other artists that feature them under **Appears on**; **See all** opens every release of a row. Under the artist's name is what tells them apart from others of that name ("1960s British band"). A big artist opened for the first time shows its releases at once and says **Loading discography…** while the rest comes in. They can start a radio when something by the artist plays for you (for someone who may fetch music, that includes what the server can fetch). An album page shows its cover, title and artist at once; when the server is still looking up its songs, the list fills in a moment later, and **Play** can be pressed already. If the songs take more than a minute, the page says so and offers **Check again**; an album whose songs the server doesn't know says **No songs listed**. Below the songs and the release date (shown as precisely as it is known: a year, a month or a day) come **Other versions** of the album (deluxe, remastered or live editions) and **More by** its artist.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted. Deleting a playlist removes no songs from your library or your other playlists. Adding songs that are already in a playlist asks first: **Add anyway** adds them again, **Skip** adds only the others. A playlist holds up to 10,000 songs, and you can have up to 1,000 playlists.

## Search

**Search** in the sidebar opens the search page, with the search field in the bar at its top. Results come as you type, as one list with every kind mixed: artists (with round pictures), albums, songs and your playlists, each row saying what it is and who made it ("Song · MGMT"). It covers all music, not only what is on your server.

- The list is ordered by how well each name matches what you typed and how well known it is: for "tate", Tate McRae comes before an artist named exactly TATE whom few people listen to, but an artist named exactly as you typed still comes before another artist's songs that only share part of a name. Music in your library, and what you play and like, rank higher.
- **All**, **Songs**, **Albums**, **Artists** and **Playlists** above the list narrow it to one kind. A narrowed list goes on as you scroll (or with **Show more**).
- Click an artist, album or playlist to open it. Click a song to play it; the songs listed after it follow in the queue. A song that cannot be played opens its album instead.
- Every row has its menu, from the **⋯** button or a right-click: a song's is the one it has everywhere; an album's plays it, queues it, adds it to a playlist, saves it to your library (or removes it) and goes to its artist; an artist's starts a radio and saves the artist to your library (or removes it).
- Music that plays looks the same whether its file is on your server or not. What you cannot play is gray, sits lower in the list and says **Not available**; when your server has the Wantlist turned on, you can add it to your [wantlist](./wantlist.md) from its menu.
- ↓ and ↑ in the search field move through the results; **Enter** opens or plays the one highlighted, or the best match.
- While you type on, the last results stay up, faded, until the new ones arrive. Your server's own music answers at once; the catalog search (Deezer by default, or the [local search index](../server/metadata-and-privacy.md#the-local-search-index)) takes a moment longer, so the list waits briefly for it, then shows what it has with a spinner at its end. If the catalog cannot be searched, the list says so and shows your server's music. If neither can be searched, the page and the quick search box say so, with **Try again**.
- What you typed and the filter you chose are in the address, so **Back** from an album or artist returns to the same results, scrolled where you left them.

Before you type, the page lists your **Recent searches** and what you opened from them (**Recently viewed**), each with an **×** to remove it and **Clear all** to remove them all, then browse-by-genre tiles, which open your albums filtered to that genre. Recent searches are kept in this browser, for your account.

### Quick search

Ctrl+K (⌘K on a Mac) opens a search box over whatever page you are on. It searches as you type and lists the first ten results of the search page, in the same order and drawn the same way.

- Move through the results with ↑ and ↓ and press Enter, or click one. An artist, album or playlist opens; a song plays, followed by the other songs found. A song that cannot be played opens its album instead.
- The last row, **See all results for "…"**, opens the search page with what you typed.
- With nothing typed, the box lists places to go: the pages of the sidebar, **Playlists**, **Liked Songs** and, for admins, **Admin panel**.
- Escape closes it.

## Playing music

Click a song, or the play button on an album or playlist. The player bar along the bottom has the transport, the seek bar, volume, the heart (**Save to library**), **Lyrics**, **Queue** and **Devices**. **Queue** opens the queue in a panel beside the page; in a narrower window the panel floats over the page's right side and dims the page; click the page or press Escape to close it. Click the artwork in the bar, or **Now Playing** at its right end, to open **Now Playing**, full screen, with lyrics (synced lyrics follow the song, and clicking a line jumps to it) or the queue beside the artwork.

On a phone the player is a small bar at the bottom with the song, **Devices** and play or pause. Tap it for **Now Playing**, which is where the queue and the lyrics are.

On a touch screen, tap a song to play it, and tap an album's or playlist's artwork to open it; its page has **Play**. With a mouse, double-click a song, or use the play button that appears over its number or artwork.

When something does not load (a page, a panel of **Settings** or **Admin**, the lyrics), it says so where it would be, with **Try again**; the rest of the screen keeps working.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Save to library** or **Remove from library** (the same as the song's heart), **Go to album** (not on the album's own page), **Go to** each of its artists, and **Add to Wantlist** for music that is not available (when the Wantlist is turned on). You can also drag songs onto a playlist, or onto Liked Songs (which saves them), in the sidebar. From the keyboard, the menu is how to reach a song's album and artists: the links in its row are left out of the Tab order, since a narrow row cuts them short. An album's **Add to playlist** waits until its songs are known.
- **Queue**: click a song in **Up next** to jump to it (the songs above it are skipped, except those you added yourself); reorder by dragging (hold a song near the top or bottom of the list to scroll it), or focus a song's handle and use the arrow keys; remove songs; **Clear** the queue or the history (a notice offers **Undo** for a few seconds). How Previous, Shuffle and Repeat treat the list a song was played from is in [The queue](../server/playback.md#the-queue). The queue holds up to 10,000 songs; adding more than fit does nothing. **Autoplay** keeps music going with similar songs when the queue runs out: the same artist, artists like it, and the same genre and era, favoring what you like. If you may fetch music, that includes songs the server doesn't have yet.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).

## Your library

Your library is the music on your server (what its owner scanned, uploaded or dropped in the inbox, shared by everyone) plus what you saved. Only you add to it, and only with the heart: playing or downloading music never does.

- **The heart** is on every song (in lists, search results, the queue and its history, at any window size; a narrow row cuts the title short and drops the album, date added and length before it), in an album's and an artist's header, in the player bar and in **Now Playing**. It saves the song, album or artist to your library at once, and a notice offers **Undo**. A song you save is in **Liked Songs** and under **Songs**; an album under **Albums**, with its songs; an artist under **Artists**. When the server can fetch music for you, it fetches anything an album or song is missing behind it. Click the heart again to remove it; your playlists and history keep it.
- Menus have **Save to library** or **Remove from library**, which does the same as the heart.
- Music on your server is in everyone's library whether or not you heart it. Its heart shows only your own save.

An empty library says what it holds and how to add to it, with **Find music**.

## Music that is not on the server yet

With an [acquisition provider](../server/acquisition.md) connected, the server fetches music when someone who may fetch plays it: admins, and members an admin allowed to. For them it works like any streaming app, and nothing in the app says where a song's file is:

- Play anything. Until you hear it, the play button and its row show the spinner the player uses for buffering, and the artist stays under the title; the same goes for a song that is slow to stream or that can't load while you are offline, and its time stays at the start instead of running. If it takes longer than eight seconds, the player says **Still loading…** instead. A seek made meanwhile is kept: the song starts there.
- The server fetches the playing song and the next five ahead of time. Songs waiting in the queue look like any other.
- A song the source doesn't have is told when it was playing or next (**Skipped “…” — not available**; several in a row share one notice that counts them, **Skipped 3 songs — not available**), turns gray with **Not available** wherever it is listed, without the list moving, and playback moves on to the next song it can play. Failures further down the queue are quiet. When none of the songs left in the queue are available, playback stops with one notice, **None of the remaining songs are available**. If five songs in a row aren't available, playback pauses with **Several songs in a row aren't available**; press play to carry on.
- When the server can't fetch music at all right now (its source is down), playback pauses at the first song with one notice, **Can't load music right now**, and why, and the songs that failed with it are not told on their own; press play to try again. A song that fails for another reason says **Couldn't play "…"**, **Skipped.**, and if three of those come in a row playback pauses the same way.

For members who may not fetch, and on servers without a provider, music that is not on the server is gray and says **Not available**; an album that is partly there says how many of its songs are available.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it into the library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

## Devices

Every open tab can play in your one playback session, one at a time. When music plays somewhere else, the player bar says "Playing on …" (or "Playing in another tab", and "Paused on …" once it is paused there) with **Play here**; the controls drive that device and this tab plays nothing. **Devices** lists where you can play: **This browser** with **Play in this tab**, one **Another tab** row for the browser's other open tabs, and each of your other devices once. Only devices that are open and responding are listed: a closed tab, or a laptop that went to sleep, drops off within seconds. Two devices of the same name are told apart by a short id; renaming one in **Settings → Playback → This browser's name** is clearer. If the device that plays drops off, the player bar says **Reconnecting to …** for up to 20 seconds, then playback pauses; **Play here** takes over at once. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

### Playing separately on one device

To have one tab play its own music while your other devices play something else (two people on one account, or two rooms), open **Devices** and choose **Play separately on this tab**. It happens at once: if this tab was playing it carries on and your other devices pause where they were; otherwise it starts from a paused copy of the queue. While it plays separately the player bar and Now Playing say **Only on this device**; press it to open **Devices** again, which then offers:

- **Rejoin your other devices**: this tab stops, drops its own queue and shows what the others play.
- **Bring this queue with me**: this tab keeps playing, and your other devices switch to its queue.

Other devices list a tab like this under **Playing separately**, with the song it plays, and playback can't be moved to it. Playing separately survives a reload; after a week away it plays with your other devices again. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

If the browser refuses to start audio on its own (after a transfer or a reload), the player shows **Play** and a notice says "Your browser is holding back audio"; press play, or **Enable audio** in the notice. "Reconnecting to the server…" means the live connection dropped; it comes back by itself, and behind a proxy it usually means WebSockets are not passed through.

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

Admins manage the server in the admin panel: choose **Admin panel** in the account menu, or under the sections of **Settings** (not on a phone). The bar at its top, titled **Admin**, links to the sections; when the window is too narrow for all of them, the rest are under **More** at its end. Each section has its own guide. The guides name them like **Admin → Library**.

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
