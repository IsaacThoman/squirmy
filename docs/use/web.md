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

- **Home** shows the rows the server sends, in its order: what you played recently and most, your playlists, what you saved to your library, new releases by artists you have or like, and your [wantlist](./wantlist.md) (when it is turned on). With nothing to show yet it says how to start: **Find music** opens the search page when the server can fetch music for you, and admins get **Add a music folder**, which opens **Admin → Library**.
- **Library** is one page holding [your library](#your-library), as on the phone. Chips across the top choose what it shows: **All** (Liked Songs first, then your playlists, then albums), **Playlists**, **Albums**, **Artists** or **Songs**. On a phone they wrap under the page's title. Sort albums by **Recently added**, **Title**, **Artist** or **Year** (songs by the first three; artists are listed by name; under **All** the sort orders the albums, after Liked Songs and the playlists), switch between a grid and a list, and use **Find in your library** to search it. A genre chosen in Search stays on **All**, **Albums** and **Songs** (songs from albums of that genre) until you remove it. If albums, artists or songs fail to load, the page says so where they would be, with **Try again**, and keeps the chips and whatever else loaded. An album none of whose songs would play for you says **Not available** under its title. The page remembers the chip and the layout you chose in this browser, and loads more as you scroll. Old links to the Albums, Artists, Songs and Playlists pages open Library on that chip.
- **Album, artist and playlist pages** play from the header. Artist pages start with the artist's top songs, then list each release once, a row per kind (Albums, Mixtapes, EPs, Singles, Live albums, Compilations, Soundtracks), with releases by other artists that feature them under **Appears on**; **See all** opens every release of a row. Under the artist's name is what tells them apart from others of that name ("1960s British band"). A big artist opened for the first time shows its releases at once and says **Loading discography…** while the rest comes in. The biography comes last, three lines of it until **More** shows the rest. They can start a radio when something by the artist plays for you (for someone who may fetch music, that includes what the server can fetch). An album page shows its cover, title and artist at once; when the server is still looking up its songs, the list fills in a moment later, and **Play** can be pressed already. If the songs take more than a minute, the page says so and offers **Check again**; an album whose songs the server doesn't know says **No songs listed**. Below the songs come the release date (shown as precisely as it is known: a year, a month or a day) and the label, then what is written about the album, then **Other versions** of the album (deluxe, remastered or live editions) and **More by** its artist.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted. Deleting a playlist removes no songs from your library or your other playlists. Adding songs that are already in a playlist asks first: **Add anyway** adds them again, **Skip** adds only the others. A playlist holds up to 10,000 songs, and you can have up to 1,000 playlists.

## Search

**Search** in the sidebar opens the search page, with the search field in the bar at its top. Results come as you type, as one list with every kind mixed: artists (with round pictures), albums, songs and your playlists, each row saying what it is and who made it ("Song · MGMT"). It covers all music, not only what is on your server.

- The list is ordered by how well each name matches what you typed and how well known it is: for "tate", Tate McRae comes before an artist named exactly TATE whom few people listen to, but an artist named exactly as you typed still comes before another artist's songs that only share part of a name. Music in your library, and what you play and like, rank higher.
- **All**, **Songs**, **Albums**, **Artists** and **Playlists** above the list narrow it to one kind. A narrowed list goes on as you scroll (or with **Show more**). If the next part does not load, the list ends with **More results didn’t load** and **Try again**, keeping what it already shows.
- Click an artist, album or playlist to open it. Click a song to play it; the songs listed after it follow in the queue. A song that cannot be played opens its album instead.
- Every row has its menu, from the **⋯** button or a right-click: a song's is the one it has everywhere; an album's plays it, queues it, adds it to a playlist, saves it to your library (or removes it) and goes to its artist; an artist's starts a radio and saves the artist to your library (or removes it).
- Music that plays looks the same whether its file is on your server or not. What you cannot play is gray, sits lower in the list and says **Not available**; when your server has the Wantlist turned on, you can add it to your [wantlist](./wantlist.md) from its menu.
- **Enter** in the search field opens or plays the best match. ↓ moves from the field into the results, and ↓ and ↑ move from row to row (↑ from the first row goes back to the field); **Enter** opens or plays the row you are on, and Tab reaches its heart and **⋯** button.
- While you type on, the last results stay up, faded, until the new ones arrive; faded results cannot be opened. Results for a different search, or for another filter, never stand in. Your server's own music answers at once; the catalog search (Deezer by default, or the [local search index](../server/metadata-and-privacy.md#the-local-search-index)) takes a moment longer, so the list waits briefly for it, then shows what it has with a spinner at its end. If the catalog cannot be searched, the page says **Couldn’t search the catalog**, with **Try again**, above your server's music (or says that nothing on your server matches) rather than "No results"; the quick search box says so too. If neither can be searched, the page and the quick search box say so, with **Try again**.
- What you typed and the filter you chose are in the address, so **Back** from an album or artist returns to the same results, scrolled where you left them.

Before you type, **Recently viewed** shows results you opened or played from Search. Use **×** beside a result to remove it, or **Clear all** to clear the list. Browse-by-genre tiles open your albums filtered to that genre. With neither, the page says what it is for. Recently viewed results are kept in this browser for your account.

Album, artist, and playlist pages show a **Back to** breadcrumb when opened from another browsing page. **Back to Search** restores the same query, filters, and scroll position.

### Quick search

Ctrl+K (⌘K on a Mac) opens a search box over whatever page you are on. It searches as you type and lists the first ten results of the search page, in the same order and drawn the same way.

- Move through the results with ↑ and ↓ and press Enter, or click one. An artist, album or playlist opens; a song plays, followed by the other songs found. A song that cannot be played opens its album instead.
- The last row, **See all results for "…"**, opens the search page with what you typed. It stays below the results, in sight however many there are.
- With nothing typed, the box lists places to go: the pages of the sidebar, **Playlists**, **Liked Songs** and, for admins, **Admin panel**.
- Escape closes it, and the keyboard is back where it was before you opened it.

## Playing music

Click a song, or the play button on an album or playlist. The player bar along the bottom has the transport, the seek bar, volume, the heart (**Save to library**), **Lyrics**, **Queue** and **Devices**. In a narrower window the volume, and then **Now Playing**, move behind **More player controls** (**⋯**); on a tablet the transport gets a row of its own under the song, so the title and credit keep their room. A credit cut short shows whole when you point at it. **Queue** opens the queue in a panel beside the page; in a window narrower than 1280 pixels the panel floats over the page's right side, dims the rest of the app and keeps the keyboard inside it; click outside it or press Escape to close it. Closing the queue puts focus back on **Queue**. Scroll down over the player bar, click its artwork or click the up chevron to slide **Now Playing** into full screen. Scroll up over the artwork or controls, or click the down chevron, to return to the bar. Lyrics and the queue scroll within their own panes. Synced lyrics follow the song, and clicking a line jumps to it. From the keyboard, Tab reaches the player's controls before the lyrics or the queue; the synced lyrics are one stop, where the arrow keys move through the lines and Enter jumps to one.

Under the song, the player says what happened to playback: a song that was skipped, why playback stopped, a radio starting (**Starting radio…**) or one that could not start, an album or playlist that did not load to play, a device you could not move playback to, and **History cleared**. It is read out by screen readers. A note about one song goes away after a few seconds; one about a stop stays until playback carries on.

On a phone the player is a small bar at the bottom with the song, **Devices** and play or pause. Tap it for **Now Playing**, which is where the queue and the lyrics are. Before anything plays the bar says **Nothing playing** and still has **Devices**, so you can choose where the first song plays.

On a touch screen every button and link has at least 44 pixels each way to press, about a fingertip. Tap a song to play it, and tap an album's or playlist's artwork to open it; its page has **Play**. With a mouse, double-click a song, or use the play button that appears over its number or artwork.

When something does not load (a page, a panel of **Settings** or **Admin**, the lyrics), it says so where it would be, with **Try again**; the rest of the screen keeps working.

Nothing pops up over the page to say what happened. What you change shows where you changed it: a filled heart, a playlist in the sidebar, a song gone from a list. Where nothing else would show it, the control says so for a moment: a menu entry reads **Added to queue** or **Added to "Road Trip"** before the menu closes, a playlist in the sidebar reads **Added** after you drop songs on it, and a field that saves as you leave it says **Saved**. When the server refuses something, it says so in the same place: beside the heart (**Couldn't save. Try again.**, and the heart goes back), on the menu entry, under the form or the setting, or in a confirmation. News about playback (a song skipped, playback stopped, a device you could not move to, **History cleared**) is on the line under the song in the player. Anything that can't be undone, such as deleting a playlist or clearing the history, asks first.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Save to library** or **Remove from library** (the same as the song's heart), **Go to album** (not on the album's own page), **Go to** each of its artists, and **Add to Wantlist** for music that is not available (when the Wantlist is turned on). You can also drag songs onto a playlist, or onto Liked Songs (which saves them), in the sidebar. Tab reaches the album and artist links in a song's row; a link the row cuts short is left out, and the menu goes to it instead. On a touch screen the menu starts with the song's whole title and artists, which a narrow row cuts short. An album's **Add to playlist** waits until its songs are known.
- **Queue**: click a song in **Up next** to jump to it (the songs above it are skipped, except those you added yourself); reorder by dragging (hold a song near the top or bottom of the list to scroll it), or focus a song's handle and use the arrow keys; remove songs; **Clear** the queue, or the history (it asks first: a cleared history can't be brought back). How Previous, Shuffle and Repeat treat the list a song was played from is in [The queue](../server/playback.md#the-queue). The queue holds up to 10,000 songs; adding more than fit does nothing. **Autoplay** keeps music going with similar songs when the queue runs out: the same artist, artists like it, and the same genre and era, favoring what you like. If you may fetch music, that includes songs the server doesn't have yet.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).

## Your library

Your library is the music on your server (what its owner scanned, uploaded or dropped in the inbox, shared by everyone) plus what you saved. Only you add to it, and only with the heart: playing or downloading music never does.

- **The heart** is on every song (in lists, search results, the queue and its history, at any window size; a narrow row cuts the title short and drops the album, date added and length before it), in an album's and an artist's header, in the player bar and in **Now Playing**. It saves the song, album or artist to your library at once; if the server refuses, the heart goes back and says **Couldn't save. Try again.** beside itself for a few seconds. A song you save is in **Liked Songs** and under **Songs**; an album under **Albums**, with its songs; an artist under **Artists**. When the server can fetch music for you, it fetches anything an album or song is missing behind it. Click the heart again to remove it; your playlists and history keep it.
- Menus have **Save to library** or **Remove from library**, which does the same as the heart.
- Music on your server is in everyone's library whether or not you heart it. Its heart shows only your own save.

An empty library says what it holds and how to add to it, with **Find music**.

## Music that is not on the server yet

With an [acquisition provider](../server/acquisition.md) connected, the server fetches music when someone who may fetch plays it: admins, and members an admin allowed to. For them it works like any streaming app, and nothing in the app says where a song's file is:

- Play anything. Until you hear it, the play button and its row show the spinner the player uses for buffering, and the artist stays under the title; the same goes for a song that is slow to stream or that can't load while you are offline, and its time stays at the start instead of running. If it takes longer than eight seconds, the player says **Still loading…** instead. A seek made meanwhile is kept: the song starts there.
- The server fetches the playing song and the next five ahead of time. Songs waiting in the queue look like any other.
- A song the source doesn't have turns gray with **Not available** wherever it is listed, without the list moving. When its turn comes playback moves on to the next song it can play, and the player says so (**Skipped “…” — not available**; several in a row share one line that counts them, **Skipped 3 songs — not available**). A song you clicked by name (its row in a list, or in the queue) is different; playing a whole album, playlist or artist from its **Play** or **Shuffle** button moves past a first song it can't have, as above: playback stays on it, paused, and says **Couldn't play "…"**, **It isn't available.**; press next to go on. When none of the songs left in the queue are available, playback stops and the player says it once, **None of the remaining songs are available**. If five songs in a row aren't available, playback pauses with **Several songs in a row aren't available**; press play to carry on.
- When the server can't fetch music at all right now (its source is down), playback pauses at the first song with one line, **Can't load music right now**, and why, and the songs that failed with it are not told on their own; press play to try again. A song that fails for another reason says **Couldn't play "…"**, **Skipped.**, and if three of those come in a row playback pauses the same way.

For members who may not fetch, and on servers without a provider, music that is not on the server is gray and says **Not available**; an album that is partly there says how many of its songs are available.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it into the library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

## Devices

Every open tab can play in your one playback session, one at a time. When playback is on another tab or device, the **Devices** button is highlighted and the controls drive that output. **Devices** lists where you can play, under "Listening on …" (or "Paused on …"): **This browser** with **Play in this tab**, which moves the music here and keeps it paused if it was, one **Another tab** row for the browser's other open tabs, and each of your other devices once. Only devices that are open and responding are listed: a closed tab, or a laptop that went to sleep, drops off within seconds. Two devices of the same name are told apart by a short id; renaming one in **Settings → Playback → This browser's name** is clearer. If the device that plays drops off, the **Devices** menu shows **Reconnecting to …** for up to 20 seconds, then playback pauses. Choose **Play in this tab** in the menu to take over. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).

### Playing separately on one device

To have one tab play its own music while your other devices play something else (two people on one account, or two rooms), open **Devices** and choose **Play separately on this tab**. It happens at once: if this tab was playing it carries on and your other devices pause where they were; otherwise it starts from a paused copy of the queue. While it plays separately, the **Devices** button stays highlighted. Open it again to see:

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
