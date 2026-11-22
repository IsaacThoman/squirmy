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
- **Background audio** keeps playing with the app closed, with lock screen and Control Center controls.
- **Now Playing.** Tap the mini-player, or pull it up, to expand it. Drag down across the artwork or song details to collapse it. Swipe left or right to skip.
- **Queue.** Pull the list down for your listening history. Drag to reorder, or swipe a track for Play Next and Remove.
- **Search** leads with the **Top result**, the best match for what you typed: an artist or album opens its page (an album also has a play button), a song plays. Below it, **In your library** lists your artists, albums and songs, and **More to discover** the ones from the catalog that you don't have, in the same order.
- **Downloads.** The download button on an album, a playlist or Liked Songs keeps it on the phone, and a song's menu has **Download**. Downloaded music always plays from the phone. **Downloads**, in the Library header and the account sheet, shows what is kept and sets the download quality, Wi-Fi only and a storage limit.
- **Streaming cache.** The app keeps the songs you played most recently on the phone, and gets the next two in your queue ahead of time. They start at once, keep playing when the connection drops, and use no data the second time. It is separate from Downloads: you choose what to download, and downloads stay until you remove them, while the cache fills by itself and removes the songs played longest ago to stay under its limit. On Wi-Fi the song you are streaming is kept too. On cellular only the songs coming up are kept, at your **Cellular** quality, and nothing is when that quality is **Data Saver**. Signing out or switching server empties it (a session that expired keeps it for when you sign in again), and iOS may empty it when the phone runs short of storage.
- **Every song has a menu**: play next or last, like, add to a playlist, start a radio, go to its album or artist. Songs not in your library can be added to your [wantlist](./wantlist.md), when your server has it on.
- **Settings**, from the account sheet: **Normalize Volume**, **Streaming Quality** on **Wi-Fi** and on **Cellular**, **Storage**, and scrobbling to [ListenBrainz and Last.fm](../server/scrobbling.md). Under **Storage**, **Streaming Cache** sets the cache's size limit (**Off**, 1, 2, 5 or 10 GB; 2 GB to begin with), **Used** shows what it holds now, and **Clear** empties it; it starts filling again when the queue moves on. A lower limit takes effect at once. The limit belongs to the phone, not to your account.

## On-demand songs

When an admin has [connected a provider](../server/acquisition.md), songs that aren't on the server yet but can be fetched show a small cloud next to the artist. Play one and its row, the mini-player and Now Playing say **Preparing…** until the file arrives, then it plays. If the server can't get it, a short notice says so, the song is skipped, and it shows gray. Members need **Can fetch missing music** for this; without it, those songs are gray, and their menu offers the wantlist instead when the server has it on.

## Known limits

- **Gapless playback is close but not sample-accurate.** The next track starts as the previous one ends, which can leave a tiny seam on continuous albums.
- **Lock screen and Control Center controls** are implemented but have not yet been verified on a physical device.
- **Volume normalization only turns loud tracks down.** It never boosts quiet ones on iOS.
- **Fetching a whole album** (**Get this album**) is only in the web app.
- **A paused phone drops off other devices' lists** once iOS suspends the app, and comes back when you open it.
- **The streaming cache does not know about Low Data Mode.** It follows the kind of network and your **Cellular** quality only. Choose **Data Saver** for cellular, or set the cache to **Off**, to stop it using cellular data.
- **Albums and artists stay gray offline unless something of theirs is downloaded**, even when the cache holds some of their songs. The songs themselves are lit wherever they are listed.
- **Android** keeps compiling but is not a focus. On Android, use a [Subsonic client](../server/subsonic.md).
