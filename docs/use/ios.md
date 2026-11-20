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

If the server has not been set up, the app says so and offers **Open in Browser** to create the admin account. On a public address over plain HTTP, the sign-in screen warns that your password is sent unencrypted; see [Reverse proxies and HTTPS](../server/reverse-proxy.md). For connection errors, see [Troubleshooting](../server/troubleshooting.md#the-app-cannot-connect).

To change servers or sign out, open the account sheet and choose **Switch server** or **Sign out**.

## Using it

The app has Home, Library (playlists, albums, artists and songs), and Search, with album, artist and playlist pages, and Now Playing with lyrics and the queue. The library is cached on the phone, so it opens at once and stays browsable while offline. Playing music still needs the server.

- **Playback is your shared session.** Whatever plays in the web app or on another device shows here too, and the phone becomes a remote without sound of its own. The playback device button, in the mini-player or Now Playing, opens **Playback device**: move playback to another device, and set the playing device's volume. Pressing play when nothing is playing makes this phone the player. See [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback).
- **Background audio** keeps playing with the app closed, with lock screen and Control Center controls.
- **Now Playing.** Tap the mini-player, or pull it up, to expand it. Drag down across the artwork or song details to collapse it. Swipe left or right to skip.
- **Queue.** Pull the list down for your listening history. Drag to reorder, or swipe a track for Play Next and Remove.
- **Every song has a menu**: play next or last, like, add to a playlist, start a radio, go to its album or artist. Songs not in your library can be added to your [wantlist](./wantlist.md).
- **Settings**, from the account sheet: **Normalize Volume**, **Streaming Quality** on **Wi-Fi** and on **Cellular**, and scrobbling to [ListenBrainz and Last.fm](../server/scrobbling.md).

## Known limits

- **Offline downloads are not in the app yet.** They are planned (files on the phone, Wi-Fi-only option); until then playback streams from the server.
- **Gapless playback is close but not sample-accurate.** The next track starts as the previous one ends, which can leave a tiny seam on continuous albums.
- **Lock screen and Control Center controls** are implemented but have not yet been verified on a physical device.
- **Volume normalization only turns loud tracks down.** It never boosts quiet ones on iOS.
- **Music you do not own** appears in search dimmed; showing it gray everywhere in the iOS app is still being finished.
- **A paused phone drops off other devices' lists** once iOS suspends the app, and comes back when you open it.
- **Android** keeps compiling but is not a focus. On Android, use a [Subsonic client](../server/subsonic.md).
