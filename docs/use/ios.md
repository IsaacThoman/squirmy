# The iOS app

The iOS app connects to your Squirmy server, browses and searches the library, and plays it as part of your shared playback session. This page covers getting the app, connecting it, what it does, and what is not finished.

## Getting the app

There is no App Store or TestFlight release yet. To use it today you build it yourself from the repository, on a Mac with Xcode. The app is in `apps/mobile` and uses Expo SDK 58. The system Liquid Glass tab bar and mini-player need iOS 26 or later.

You need Node.js 22.13 or newer. Install from the repository root, which also applies the patch in `patches/` that the app depends on:

```sh
git clone https://github.com/IsaacThoman/squirmy.git
cd squirmy
npm ci
cd apps/mobile
```

Then pick one:

- **Try it in a simulator.** Start Expo and press `i` to open it in the iOS Simulator in an SDK 58-compatible Expo Go:

  ```sh
  npx expo start --go
  ```

- **Build the standalone app** in Xcode and run it in the simulator:

  ```sh
  npm run ios
  ```

- **Install it on your iPhone.** Connect the phone, then build for it in the Release configuration:

  ```sh
  npx expo run:ios --device --configuration Release
  ```

  The native project is generated into `apps/mobile/ios/` (it is not committed). Signing needs your own Apple developer team, and the bundle identifier in `app.json` (`com.isaacthoman.music`) belongs to the maintainer, so set your own team and a bundle identifier of your own under **Signing & Capabilities** in Xcode (open `ios/Squirmy.xcworkspace`) if the build asks for one. This route has not been written up from a fresh machine yet; expect to know your way around Xcode signing.

For working on the app itself, the [README](https://github.com/IsaacThoman/squirmy#mobile-app) describes the **Squirmy Dev** development build, which installs next to the regular app and loads code from Metro.

## Connecting to your server

1. On first launch, **Connect to your server** asks for its address. Type it as you would in a browser: `music.example.com`, or `http://192.168.1.20:4747` on your home network. Without `http://` or `https://`, the app tries HTTPS first and then HTTP.
2. Choose **Continue**. The first time it reaches a server on your local network, iOS asks to allow Local Network access; allow it.
3. Sign in with your username and password, or create an account with an invite code from your admin.

If the server has not been set up, the app says so, shows which version of Squirmy it runs, and offers **Open in Browser** to create the admin account. On a public address over plain HTTP, the sign-in screen warns that your password is sent unencrypted; see [Reverse proxies and HTTPS](../server/reverse-proxy.md). For connection errors, see [Troubleshooting](../server/troubleshooting.md#the-app-cannot-connect).

The sign-in screen and the account sheet show the server's address and its Squirmy version, as the server reports it now: a release number such as `1.4.0`, or `dev` (with the commit, for example `dev+1a2b3c4`) for a server run from a checkout or an image built without a version.

The app keeps your sign-in in the iPhone's keychain. If the keychain refuses it (a build without the keychain entitlement, for instance), the app still works until you quit it, and says once that you will need to sign in again next time.

To change servers or sign out, open the account sheet and choose **Switch server** or **Sign out**.

## Using it

The app has Home, Library (playlists, albums, artists and songs: the music on your server plus what you added, not songs fetched only because you played them), and Search, with album, artist and playlist pages, and Now Playing with lyrics and the queue. The library is cached on the phone, so it opens at once and stays browsable while offline. Without a connection, downloaded music plays, and so does what the streaming cache holds.

- **Playback is your shared session.** Whatever plays in the web app or on another device shows here too, and the phone becomes a remote without sound of its own. The playback device button, in the mini-player or Now Playing, opens **Playback device**: move playback to another device, and set the playing device's volume. Pressing play when nothing is playing makes this phone the player. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).
- **Volume is the phone's own.** The slider in Now Playing, and in **Playback device** while this phone plays, is the system volume: the side buttons and Control Center move it too, and the AirPlay button sits beside it. The app has no volume of its own on top (only volume normalization, if on). Other devices see this phone's real level, and when one of them changes it while the phone plays, the phone's volume moves to match (iOS shows its volume indicator). While another device plays, the slider sets that device's volume. Like Apple Music's, the slider has no knob: drag anywhere along the bar, and it thickens while you drag. The iOS Simulator has no system volume, so the slider is blank there.
- **Background audio** keeps playing with the app closed, with lock screen and Control Center controls. The star beside them, as in Apple Music, is the song's heart: it is filled when the song is in your library, and tapping it saves or removes the song, as the heart in the app does. It shows once the song's details have loaded.
- **Now Playing.** Tap the mini-player, or pull it up, to expand it. Under the grabber it says what is playing from: an album, playlist, artist, radio or search, as in the web app. Drag down across the artwork or song details to collapse it. Swipe left or right to skip. A long title wraps to a second line. **Lyrics** shows a spinner while they load, says **No lyrics available** (or **Instrumental**) when the song has none, and **Couldn’t load lyrics** with **Try again** when the request failed.
- **Queue.** Pull the list down for your listening history. Tap a song to jump to it (the songs above it are skipped, except those you added yourself). Drag to reorder, or swipe a track for Play Next and Remove. How Previous, Shuffle and Repeat treat the list a song was played from is in [The queue](../server/playback.md#the-queue). The queue holds up to 10,000 songs; adding more than fit does nothing. A song whose details haven't loaded says **Loading…**, or offline **Song not loaded**, and has no heart or menu until they arrive.
- **Search** shows one list as you type, every kind mixed (artists with round pictures, albums, songs and your playlists, each saying what it is: "Album · MGMT"), ordered by how well the name matches and how well known it is, with your own music and what you play ranked higher. **All**, **Songs**, **Albums**, **Artists** and **Playlists** at the top narrow it to one kind, which loads more as you scroll. A song plays, with the songs found after it in the queue; an artist, album or playlist opens. Hold a row, or tap its **⋯**, for its menu: a song's usual menu, an album's **Play**, **Shuffle** and **Go to artist**, an artist's **Start radio**. The last results stay on screen until the new ones arrive, so the list doesn't empty as you type, and scrolling hides the keyboard. Before you type, Search lists your recent searches and what you opened from them (tap **×** beside a search to remove it, **Clear** to remove them all), then genres. Recent searches stay on the phone, for your account on that server.
- **Your library** is what you heart, plus the music stored on your server. The heart is the one control: on a song, on an album page and on an artist page, it saves that to your library (a song also joins **Liked Songs**, an artist shows under **Artists**), and tapping it again removes it. A short confirmation offers **Undo**. Playing or downloading never adds anything. Music stored on the server is always in everyone's library; its heart only shows whether you saved it yourself. Until you save something, Library invites you to find music in Search.
- **Downloads.** The download button on an album, a playlist or Liked Songs keeps it on the phone, and a song's menu has **Download**. Downloaded music always plays from the phone. Everything you can play downloads, also songs the server doesn't have yet: it gets them first, and each downloads as soon as it is there, so a download can take longer than its size suggests. The line under the buttons counts every song (**Downloading 2 of 3**) and says **Downloaded** only once all of them are on the phone. A song the server can't get is counted as **not available** (**2 of 3 downloaded · 1 not available**), with **Retry** to ask again. Without **Can fetch missing music**, only songs stored on the server download, and the rest are counted the same way. **Downloads**, in the Library header and the account sheet, shows what is kept and sets the download quality, Wi-Fi only and a storage limit.
- **Streaming cache.** The app keeps the songs you played most recently on the phone, and gets the next two in your queue ahead of time. They start at once, keep playing when the connection drops, and use no data the second time. It is separate from Downloads: you choose what to download, and downloads stay until you remove them, while the cache fills by itself and removes the songs played longest ago to stay under its limit. On Wi-Fi the song you are streaming is kept too. On cellular only the songs coming up are kept, at your **Cellular** quality, and nothing is when that quality is **Data Saver**. Signing out or switching server empties it (a session that expired keeps it for when you sign in again), and iOS may empty it when the phone runs short of storage.
- **Every song has a menu**: play next or last, **Save to library** or **Remove from library** (the same as its heart), add to a playlist, start a radio (from songs the server plays for you), go to its album or to each of its artists. An artist page lists each release once, grouped by kind (Albums, EPs & Singles, Compilations, Live Albums, Soundtracks, Other Releases), with releases by other artists that feature them under **Appears On**, and has a radio button when something by the artist plays for you. A heading with more than 20 releases, and Top Songs or a Home song row with more than 5 songs, has **See all**. An album page numbers each disc separately under its own heading and ends with the release date and label; explicit songs are marked **E**. Songs you can't play can be added to your [wantlist](./wantlist.md), when your server has it on.
- **Playlists.** **Add to playlist** in a song's menu lists your playlists, or makes a new one (names can be up to 120 characters). A playlist that already has the song doesn't get it twice unless you choose **Add Anyway**: the app asks first, or, for a playlist you haven't opened on the phone, says it is already there. Removing a song from a playlist offers **Undo**, which puts it back where it was. Confirmations appear just above the mini-player, or at the top of the screen while Now Playing is open, so they never cover its controls.
- **Settings**, from the account sheet: **Normalize Volume**, **Streaming Quality** on **Wi-Fi** and on **Cellular**, **Storage**, and scrobbling to [ListenBrainz and Last.fm](../server/scrobbling.md). Under **Storage**, **Streaming Cache** sets the cache's size limit (**Off**, 1, 2, 5 or 10 GB; 2 GB to begin with), **Used** shows what it holds now, and **Clear** empties it; it starts filling again when the queue moves on. A lower limit takes effect at once. The limit belongs to the phone, not to your account.
- **Larger text.** The app follows the system text size. Sheets that grow taller than the screen scroll, so **Sign out** and the device actions stay in reach. At the accessibility sizes, Settings puts each choice under its name and sign-in stacks the server's name and address; from **xxLarge** up, the mini-player shows the song's title alone, larger, instead of two smaller lines.

## Playing separately on one device

To have the phone play its own music while your other devices play something else (two people on one account, or two rooms), open **Playback device** and choose **Play separately on this iPhone**. It happens at once: if the phone was playing it carries on and your other devices pause where they were; otherwise it starts from a paused copy of the queue. While it plays separately, the mini-player and Now Playing say **Only on this device** where they would name the playing device, also while a song is still loading; press it (or the crossed-out link beside it in the mini-player) to open **Playback device** again, which says the same at the top and then offers:

- **Rejoin your other devices**: the phone's own queue is cleared and it shows what your other devices play.
- **Bring this queue with me**: your other devices switch to what the phone plays, and the phone keeps playing.

Every device lists one playing like this under **Playing separately**, with the song it plays, and playback can't be moved to it. Playing separately survives a relaunch; after a week away the phone plays with your other devices again, and says so.

## On-demand songs

When an admin has [connected a provider](../server/acquisition.md), songs that aren't on the server yet look and play like any other: nothing marks where a song's file is. Play one and the play button and its row show the same spinner as buffering while the server gets it, and the artist stays under the title; after eight seconds the current song's subtitle says **Still loading…** (while the phone plays separately, the mini-player keeps saying **Only on this device**). Songs further up the queue show nothing special. If the source doesn't have the song playing or the next one, a short notice says **Skipped “Title” — not available** (or **Skipped 3 songs — not available** when several go in a row), playback moves on to the next song it can play, and the song shows gray with **Not available**. When none of the songs left in the queue are available, playback stops and one notice says **None of the remaining songs are available**. If five songs in a row aren't available, playback pauses with **Several songs in a row aren’t available**; press play to carry on. When the server can't fetch music at all right now (its source is down), it pauses at the first song, and one notice says **Can’t load music right now** and why; press play to try again. A song that fails for another reason says **Couldn’t play “Title”**, and after several of those in a row the server pauses the same way. Members need **Can fetch missing music** for this; without it, those songs are gray (**Not available**), an album with some of them says how many songs are available, and their menu offers the wantlist instead when the server has it on. Offline, songs that would play with a connection say **Not downloaded**.

## Known limits

- **Gapless playback is close but not sample-accurate.** The next track starts as the previous one ends, which can leave a tiny seam on continuous albums.
- **Lock screen and Control Center controls** are implemented but have not yet been verified on a physical device.
- **Volume normalization only turns loud tracks down.** It never boosts quiet ones on iOS.
- **A paused phone drops off other devices' lists** once iOS suspends the app, and comes back when you open it.
- **The streaming cache does not know about Low Data Mode.** It follows the kind of network and your **Cellular** quality only. Choose **Data Saver** for cellular, or set the cache to **Off**, to stop it using cellular data.
- **Albums and artists stay gray offline unless something of theirs is downloaded**, even when the cache holds some of their songs. The songs themselves are lit wherever they are listed.
- **Android** keeps compiling but is not a focus. On Android, use a [Subsonic client](../server/subsonic.md).
