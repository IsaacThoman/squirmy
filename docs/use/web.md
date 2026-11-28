# The web app

The web app is served by your Squirmy server at its own address, such as `https://music.example.com`. Sign in, and it is your library, a player, and (for admins) the server's admin panel. This page is a short tour.

To open it like an app, install it from your browser (**Install** in Chrome or Edge, **Add to Dock** in Safari on a Mac, **Add to Home Screen** on a phone). It opens in a window of its own, with the Squirmy icon.

## Getting around

The sidebar has **Home**, **Search**, **Library**, **Replay**, the **Wantlist** (when your server has the Wantlist turned on) and **Add music** (for admins and people who may upload). Below them are your **Playlists**, with **Liked Songs** first. The **+** next to Playlists makes a **Playlist** or a [**Smart playlist**](#smart-playlists), and the **Playlists** heading opens the page with all of them. A smart playlist has a small sparkle after its name. Right-click a playlist to **Play** it.

The button with your name, at the foot of the sidebar, opens the account menu: **Settings**, **Admin panel** (for admins) and **Log out**.

The sidebar changes shape, and this browser remembers how you left it:

- **Fold it** to a rail of icons with **Close sidebar**, the button at its top. The rail keeps the pages, Liked Songs and your playlists (as their covers, named when you point at them) and the account menu. The logo at the top of the rail opens it again (**Open sidebar**). Ctrl+B (⌘B on a Mac) does both.
- **Resize it** by dragging its right edge. Dragging far enough to the left folds it, and a double click on the edge brings back the default width.
- **On a phone**, or in a window narrower than 768 pixels, the sidebar is a drawer. Open it with the button at the top left of the page. It closes when you pick something, tap outside it or press Escape.

Most pages have a bar across the top with the page's name and, on some, links to its sections and controls such as sorting. The bar stays in place while the page scrolls. **Back** and **Forward** return to where each page was scrolled, and each row that scrolls sideways (such as Home's **Recently played**) to where it was; a link opens its page at the top. Album, artist and playlist pages and Liked Songs start with their artwork instead.

- **Home** shows the rows the server sends, in its order: what you played recently and most, your playlists, **New on this server** (the albums most recently added to the server, whoever added them), new releases by artists you saved or who are credited on albums in your library, and your [wantlist](./wantlist.md) (when it is turned on). **See all** on **New on this server** opens [On this server](#on-this-server). With nothing to show yet it says how to start: **Find music** opens the search page when the server can fetch music for you, and admins get **Add a music folder**, which opens **Admin → Library**.
- **Library** is one page holding [your library](#your-library). Chips across the top choose what it shows (the iOS app has no chips: its Library is what **All** is here): **All** (Liked Songs, your playlists, albums and artists together in one grid), **Playlists**, **Albums**, **Artists** or **Songs**. On a phone they wrap under the page's title. **All** opens in **Recently played**: what you last [started playing from or added](#what-counts-as-played) comes first, then everything else, most recently added first. It can also be sorted by **Recently added**, **Title**, **Artist** (an artist leads its own albums, a playlist goes by its owner) or **Year** (albums by year, then the rest by title). On **All**, right-click an album, artist, playlist or Liked Songs, or open its **⋯** menu, and choose **Pin to top**: it stays at the top whatever the sort, most recently pinned first, with a pin before its subtitle, on all your devices. **Unpin** puts it back in its place. You can pin up to 50, and a pinned album or artist you remove from your library stops showing. Sort albums by **Recently added**, **Title**, **Artist** or **Year** and songs by the first three; artists are listed by name. A sort other than the chip's own is kept in the page's address, not remembered. Switch between a grid and a list, and use **Find in your library** to search it. A genre chosen in Search stays on **All** (which then lists only the albums of that genre), **Albums** and **Songs** (songs from albums of that genre) until you remove it. If the library, albums, artists or songs fail to load, the page says so where they would be, with **Try again**, and keeps the chips and whatever else loaded. An album none of whose songs would play for you says **Not available** under its title. The page remembers the chip and the layout you chose in this browser, and loads more as you scroll. If the next part does not load, the list stops there with **Try again** rather than asking over and over; Liked Songs and an artist's releases do the same. Old links to the Albums, Artists, Songs and Playlists pages open Library on that chip.
- **Album, artist and playlist pages** let you play a song from its row. To play a whole album, playlist or Liked Songs, use **Play** or **Shuffle** in its **⋯** menu. Artist pages start with the artist's top songs, then list each release once, a row per kind (Albums, Mixtapes, EPs, Singles, Live albums, Compilations, Soundtracks), with releases by other artists that feature them under **Appears on**; **See all** opens every release of a row. Under the artist's name is what tells them apart from others of that name ("1960s British band"). A big artist opened for the first time shows its releases at once and says **Loading discography…** while the rest comes in. The biography comes last, three lines of it until **More** shows the rest. They can start a radio when something by the artist plays for you (for someone who may fetch music, that includes what the server can fetch). An album page shows its cover, title and artist at once; when the server is still looking up its songs, the list fills in a moment later. If the songs take more than a minute, the page says so and offers **Check again**; an album whose songs the server doesn't know says **No songs listed**. Below the songs come the release date (shown as precisely as it is known: a year, a month or a day) and the label, then what is written about the album, then **Other versions** of the album (deluxe, remastered or live editions) and **More by** its artist. The artist page lists an album once, as its standard edition; its deluxe and other editions are under **Other versions** on the album page, and the deluxe's page lists the standard edition there.
- **Playlists** you own can be renamed, made public or private, reordered by dragging or with **Move up** and **Move down**, and deleted. Deleting a playlist removes no songs from your library or your other playlists. Adding songs that are already in a playlist asks first: **Add anyway** adds them again, **Skip** adds only the others. If the playlist can't be checked for them, nothing is added and the menu entry says so, to try again. When **New playlist** makes the playlist but its songs don't go in, the dialog says so and stays open: **Create** again adds them to the playlist it made, not to a second one. A playlist holds up to 10,000 songs, and you can have up to 1,000 playlists.

On an album, tracks of the same work appear under its title, with movement numbers and names when available. Select **Credits** in a track row or its **⋯** menu to see contributors and open their artist pages. An **E** marks explicit tracks. An artist's **Composed / Produced** section lists tracks they worked on without a performance credit.

### Smart playlists

A smart playlist is a playlist made of rules instead of songs you add: "jazz from the 70s", "songs I liked but haven't played in three months", "the 50 most played". Its songs are found again every time it opens, so it keeps up as music arrives, as you heart songs and as you play them. Make one with the **+** next to Playlists (**Smart playlist**) or **New smart playlist** on the Library's **Playlists** chip.

- **Songs from** is **Your library** or **All music on this server**. Only songs with a file on the server are listed, so everything in a smart playlist plays.
- Each rule tests one thing: **Title**, **Artist**, **Album artist**, **Album**, **Genre** or **Format** (contains, doesn't contain, is, is not; capitals and accents don't matter, so "beyonce" finds Beyoncé), **Year**, **Length** (in minutes), **Plays**, **Bitrate** or **Sample rate** (is, is not, more or less than, between), **Decade**, **Date added** or **Last played** (in or not in the last so many days, weeks, months or years, before a day, or on or after it), **Liked** and **Lossless** (yes or no). Plays, last played and likes are yours.
- **Match all** or **any** of the rules. **Add group** adds a box of rules with its own all or any, for "jazz, and from the 60s or the 70s".
- **Order** is **Random**, **Most played**, **Least played**, **Recently added**, **Recently played**, **Title**, **Artist** or **Year**, and **Limit** keeps the first so many songs (up to 10,000). Random is shuffled once a day, so a limited random playlist is a fresh pick each day.
- While you edit, the dialog counts the songs the rules find. A rule left unfinished is marked when you press **Create** or **Save**.

A smart playlist plays and shuffles from its **⋯** menu like any playlist. Its songs can't be dragged, moved or removed by hand, and songs can't be added to it, so it isn't offered in **Add to playlist**. **Edit rules** in its **⋯** menu changes its name, rules and whether it's public. A public smart playlist shows everyone the songs your rules find in *your* library and plays. In Subsonic apps it is a read-only playlist, and in the iOS and Apple TV apps it opens and plays like the others (its rules are edited on the web).

## Search

**Search** in the sidebar opens the search page, with the search field in the bar at its top. Results come as you type, as one list with every kind mixed: artists (with round pictures), albums, songs and your playlists, each row saying what it is and who made it ("Song · MGMT"). It covers all music, not only what is on your server.

- The list is ordered by how well each name matches what you typed and how well known it is: for "tate", Tate McRae comes before an artist named exactly TATE whom few people listen to, but an artist named exactly as you typed still comes before another artist's songs that only share part of a name. Music in your library, and what you play and like, rank higher.
- **All**, **Songs**, **Albums**, **Artists** and **Playlists** above the list narrow it to one kind. A narrowed list goes on as you scroll (or with **Show more**). If the next part does not load, the list ends with **More results didn’t load** and **Try again**, keeping what it already shows.
- Click an artist, album or playlist to open it. Click a song to play it on its own: the other songs found are not queued, so when it ends **Autoplay** goes on with similar music (when it is on; otherwise playback stops). A song that cannot be played opens its album instead. The quick search box (Ctrl+K or ⌘K) plays a song the same way.
- Every row has its menu, from the **⋯** button or a right-click (on a touch screen, tap **⋯**, or hold the row; a swipe that starts on **⋯** scrolls instead): a song's is the one it has everywhere; an album's plays it, queues it, adds it to a playlist, saves it to your library (or removes it) and goes to its artist; an artist's starts a radio and saves the artist to your library (or removes it).
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

Click a song, use **Play** in an album’s menu, or press **Play** on a playlist or Liked Songs. The player bar along the bottom has the transport, the seek bar, volume, the heart (**Save to library**), **Lyrics**, **Queue** and **Devices**. In a narrower window the volume, and then **Now Playing**, move behind **More player controls** (**⋯**); on a tablet the transport gets a row of its own under the song, so the title and credit keep their room. A credit cut short shows whole when you point at it. **Queue** opens the queue in a panel beside the page; in a window narrower than 1280 pixels the panel floats over the page's right side, dims the rest of the app and keeps the keyboard inside it; click outside it or press Escape to close it. Closing the queue puts focus back on **Queue**. Scroll down over the player bar, click its artwork or click the up chevron to slide **Now Playing** into full screen. Scroll up over the artwork or controls, or click the down chevron, to return to the bar. Lyrics and the queue fade in and out within Now Playing and scroll within their own panes. Now Playing reopens on the pane you last selected. Switching between them keeps the artwork in place on a wide screen. The transitions follow your reduced-motion preference. Synced lyrics follow the song, and clicking a line jumps to it. From the keyboard, Tab reaches the player's controls before the lyrics or the queue; the synced lyrics are one stop, where the arrow keys move through the lines and Enter jumps to one.

Under the song, the player says what happened to playback: a song that was skipped, why playback stopped, a radio starting (**Starting radio…**) or one that could not start, an album or playlist that did not load to play, **Couldn’t load the whole list** when only part of a long list (Liked Songs, your songs) loaded to play (it plays what did), a device you could not move playback to, and **History cleared**. It is read out by screen readers. A note about one song goes away after a few seconds; one about a stop stays until playback carries on.

**Sleep timer**: the moon button in Now Playing, beside **Lyrics** and **Queue**, stops playback after 5 to 60 minutes, at the **End of song**, or at the **End of album** (or playlist, or queue). The one set has a check mark, and **Turn off timer** cancels it. While one is set the moon is highlighted, and the player bar shows a moon with the time left (or what it waits for); click it for the same menu. The music fades out over the last ten seconds. The timer is your session's: it stops whichever device plays. See [Sleep timer](../server/playback.md#sleep-timer).

On a phone the player is a small bar at the bottom with the song, **Devices** and play or pause. Tap it for **Now Playing**, which is where the queue and the lyrics are. Before anything plays the bar says **Nothing playing** and still has **Devices**, so you can choose where the first song plays.

On a touch screen every button and link has at least 44 pixels each way to press, about a fingertip. Tap a song to play it, and tap an album's or playlist's artwork to open it; its page has **Play**. With a mouse, double-click a song, or use the play button that appears over its number or artwork.

When something does not load (a page, a panel of **Settings** or **Admin**, the lyrics), it says so where it would be, with **Try again**; the rest of the screen keeps working.

Nothing pops up over the page to say what happened. What you change shows where you changed it: a filled heart, a playlist in the sidebar, a song gone from a list. Where nothing else would show it, the control says so for a moment: a menu entry reads **Added to queue** or **Added to "Road Trip"** before the menu closes, a playlist in the sidebar reads **Added** after you drop songs on it, and a field that saves as you leave it says **Saved**. When the server refuses something, it says so in the same place: beside the heart (**Couldn't save. Try again.**, and the heart goes back), on the menu entry, under the form or the setting, or in a confirmation. News about playback (a song skipped, playback stopped, a device you could not move to, **History cleared**) is on the line under the song in the player. Anything that can't be undone, such as deleting a playlist or clearing the history, asks first.

- **Song menus** (right-click or the **⋯** button): **Play next**, **Add to queue**, **Add to playlist** (or **New playlist…**), **Start radio**, **Songs that sound like this** (a radio that keeps to the song's [sound](../server/sonic-analysis.md#how-radio-uses-it) more than to its artist and genre), **Save to library** or **Remove from library** (the same as the song's heart), **Go to album** (not on the album's own page), **Go to** each of its artists, and **Add to Wantlist** for music that is not available (when the Wantlist is turned on). You can also drag songs onto a playlist, or onto Liked Songs (which saves them), in the sidebar. Tab reaches the album and artist links in a song's row; a link the row cuts short is left out, and the menu goes to it instead. On a touch screen the menu starts with the song's whole title and artists, which a narrow row cuts short. An album's **Add to playlist** waits until its songs are known. The song playing has the same menu, from the **⋯** beside its heart in **Now Playing**, and so does every song in the queue; there it also has **Track info**.
- **Lossless and Track info.** Under the seek bar in **Now Playing**, between the times, a **Lossless** or **Hi-Res Lossless** badge shows while the device playing gets a lossless file as it is (hi-res is above 48 kHz or 16-bit). Click it, or choose **Track info** in the song's menu, for the song's file (format, sample rate, bit depth, bitrate, channels and size), how it reaches the device (**Original file**, or **Transcoded to …** and why: your streaming quality setting, or a device that can't play the format), the volume normalization applied, and which device is playing. While you control another device, it shows what that device plays. See [Seeing what plays](../server/playback.md#seeing-what-plays).
- **Album menus** (right-click a card or open its **⋯**, or the **⋯** in an album's header): **Play** and **Shuffle**, **Play next**, **Add to queue**, **Add to playlist**, **Save to library** or **Remove from library**, and **Go to** each of its artists.
- **Queue**: laid out as in the iOS app. It opens on the song playing, with the **History** above it (scroll up to see it, oldest first), the **Shuffle**, **Repeat** and **Autoplay** toggles under it, then the songs coming up and the Autoplay suggestions. The songs coming up are headed **Continue Playing** ("From" the album or playlist) while they all come from what is playing, and **Up Next** once you have queued songs yourself. Each list's heading stays at the top while you scroll through it. Click a song coming up to jump to it (the songs above it are skipped, except those you added yourself); drag the song row to reorder it (press and hold on a touchscreen), or focus the song and use the arrow keys. A song's **⋯** opens its menu; for a song coming up, **Play next** and **Move to end** move it rather than adding it again. Drag near the top or bottom to scroll the list; remove songs; **Clear** the queue, or the history (it asks first: a cleared history can't be brought back). How Previous, Shuffle and Repeat treat the list a song was played from is in [The queue](../server/playback.md#the-queue). The queue holds up to 10,000 songs; adding more than fit does nothing. **Autoplay** keeps music going with similar songs when the queue runs out: the same artist, artists like it, and the same genre and era, favoring what you like. If you may fetch music, that includes songs the server doesn't have yet.
- **Your settings** in **Settings → Playback**: **Volume normalization**, **Streaming quality**, **Cellular quality** (for the iOS app), and **This browser's name**. See [Playback](../server/playback.md).
- **Settings → Library** has **Show all of this server’s music in your library** (see [Your library](#your-library)) and, for people who may upload, a link to **Your uploads**.

## Your library

Your library is what you saved with the heart, the music you uploaded, and your playlists. Only you add to it, and only with the heart (an upload hearts its albums for you when it finishes): playing or downloading music never does. The rest of the music on your server is shared by everyone: it is on Home and in [On this server](#on-this-server), search finds it, and it plays, but it is not in your library until you heart it.

To have all of the server's music in your library as well, turn on **Settings → Library → Show all of this server’s music in your library**. It is off unless you turn it on; libraries used to hold all of it, so after this change a library holds only what its owner hearted and uploaded until they turn it on.

- **The heart** is on every song (in lists, search results, the queue and its history, at any window size; a narrow row cuts the title short and drops the album, date added and length before it), in an album's and an artist's header, in the player bar and in **Now Playing**. It saves the song, album or artist to your library at once; if the server refuses, the heart goes back and says **Couldn't save. Try again.** beside itself for a few seconds. A song you save is in **Liked Songs** and under **Songs**; an album under **Albums**, with its songs; an artist under **Artists**. When the server can fetch music for you, it fetches anything an album or song is missing behind it. Click the heart again to remove it; your playlists and history keep it.
- Menus have **Save to library** or **Remove from library**, which does the same as the heart.
- With **Show all of this server’s music in your library** on, music on your server is in your library whether or not you heart it, and its heart shows only your own save.

An empty library says what it holds and how to add to it, with **Find music** and **Browse this server**.

## On this server

**On this server** lists all of the server's music, whatever is in your library: what was scanned from its folders, uploaded or dropped in its inbox (not music fetched only because someone played it). Open it from **See all** on Home's **New on this server**, or from an empty library's **Browse this server**. It is the Library's view with **Albums**, **Artists** and **Songs** chips, the same sorts, grid or list, genre and **Find on this server**, and no pins or playlists.

### What counts as played

Library's **Recently played** follows what you start playing from and what you add, on any of your devices, and moves on your other open devices as you play:

- A collection is played when you play a song on its page, or use **Play** or **Shuffle** in an album’s, a playlist’s or Liked Songs’ **⋯** menu. Playing an album or playlist from its card counts too, as does playing one of an artist’s Top songs.
- A song started from Search, Home, a radio or your history counts for none of them, not even its album, because you didn't start it from there.
- Playback that goes on by itself (the next song, Autoplay), **Next**, **Previous**, and resuming after a pause change nothing.
- Adding something counts too: an album or artist you heart, Liked Songs when you heart a song, a playlist you create, and an album you upload go to the top. Taking a heart back with Undo puts it back where it was, and hearting something already in your library doesn't move it.

Music played before your server had this feature isn't in the order: it fills in as you play.

## Replay

Open **Replay** from the sidebar for your listening time, plays, top tracks, artists, albums and genres. The listening clock shows play counts by day and hour in your browser's time zone. A streak is a run of consecutive days with a play. The current streak can still continue if you last listened yesterday. **New discoveries** are artists you first played during the selected period.

Choose **This week**, **This month**, **This year**, **All time** or **Year in Review** and pick a year. Weeks start Monday. Calendar comparisons use the full previous period, even while the current one is still in progress. Early skips are left out. Each credited artist gets the play, and an album with multiple genres can contribute to each genre.

### Import or export listening history

At the bottom of Replay, choose **Import history**, a source and one file of up to 128 MB. You can leave the page while the server works. **Recent imports** shows progress and how many rows matched, stayed unmatched, were duplicates or were ignored.

- **ListenBrainz** accepts listens in a JSON array, in a JSON response containing `listens`, or in a JSON Lines file. If your export is a ZIP, extract it first and choose the files under `listens/` one at a time. [ListenBrainz export format](https://listenbrainz.readthedocs.io/en/latest/users/api/export.html)
- **Last.fm** accepts a CSV with artist, album, track and timestamp, with or without the header. [LastFM to CSV](https://benjaminbenben.com/2014/05/29/lastfm-to-csv/)
- **Spotify** accepts the audio JSON files from **Extended Streaming History**, such as `Streaming_History_Audio_*.json` or `endsong_*.json`. Choose each file separately. Squirmy estimates a play’s start by subtracting the listening duration from the end time. Rows without track metadata, such as podcasts, are ignored. [Spotify export details](https://support.spotify.com/sg-en/article/understanding-your-data/)

Matched listens can link to and play from your server's catalog. Unmatched listens still count in Replay and stay in your private history, with no catalog entry created. If a listen has no duration, Squirmy uses the matched track's length when known and otherwise adds no listening time. Imports never scrobble. Uploading the same listens again from the same source keeps one copy. If an import fails partway through, any batches already processed remain in your history.

**Export history** downloads your recorded plays, including skips and unmatched imports, in JSON or CSV. The JSON preserves the original text of each entry. CSV fields that spreadsheet apps might treat as formulas are prefixed with an apostrophe.

## Music that is not on the server yet

With an [acquisition provider](../server/acquisition.md) connected, the server fetches music when someone who may fetch plays it: admins, and members an admin allowed to. For them it works like any streaming app, and nothing in the app says where a song's file is:

- Play anything. Until you hear it, the play button and its row show the spinner the player uses for buffering, and the artist stays under the title; the same goes for a song that is slow to stream or that can't load while you are offline, and its time stays at the start instead of running. If it takes longer than eight seconds, the player says **Still loading…** instead. A seek made meanwhile is kept: the song starts there.
- The server fetches the playing song and the next five ahead of time. Songs waiting in the queue look like any other.
- A song the source doesn't have turns gray with **Not available** wherever it is listed, without the list moving. When its turn comes playback moves on to the next song it can play, and the player says so (**Skipped “…” — not available**; several in a row share one line that counts them, **Skipped 3 songs — not available**). A song you clicked by name (its row in a list, or in the queue) is different; playing a whole album from its menu's **Play** or **Shuffle** moves past a first song it can't have, as above: playback stays on it, paused, and says **Couldn't play "…"**, **It isn't available.**; press next to go on. When none of the songs left in the queue are available, playback stops and the player says it once, **None of the remaining songs are available**. If five songs in a row aren't available, playback pauses with **Several songs in a row aren't available**; press play to carry on.
- When the server can't fetch music at all right now (its source is down), playback pauses at the first song with one line, **Can't load music right now**, and why, and the songs that failed with it are not told on their own; press play to try again. A song that fails for another reason says **Couldn't play "…"**, **Skipped.**, and if three of those come in a row playback pauses the same way.

For members who may not fetch, and on servers without a provider, music that is not on the server is gray and says **Not available**; an album that is partly there says how many of its songs are available.

## Adding music

**Add music** uploads album folders, files or zip archives from your computer, with progress for each file, **Pause** and **Cancel**. The server identifies what arrives and files it for everyone, and adds its albums to your library; the page follows each import to its albums and lists your recent imports. See [Adding music](../server/adding-music.md#uploading).

**Your uploads** (from **Add music**, the account menu, or **Settings → Library**) lists the albums you uploaded with their cover, songs, size and when they arrived. Open one to see its songs. **Delete album** (in its **⋯** menu) and the bin beside a song delete the files from the server, for everyone, after asking; it can't be undone. A scanned copy of the same song, or someone else's upload of it, stays. Admins have the same for everyone's uploads, and the inbox's, in **Admin → Uploads**, with **Uploaded by** to show one person's.

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
- **Account**: **Edit name** (for admins), **Change password** and **Log out**. **Log out** works even when the server can't be reached: this browser signs out at once, sign-in says the server couldn't be reached, and the session ends on the server the next time the app reaches it. When your session ends some other way (your password was changed, or your account was turned off), sign-in says **Your session ended**.
- **Scrobbling** has [ListenBrainz and Last.fm](../server/scrobbling.md) and **Share what I’m listening to with other users on this server** for [Subsonic now playing](../server/subsonic.md#how-it-maps-onto-squirmy). Sharing starts off.
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
