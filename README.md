# TONE

TONE is an iOS-first Expo music prototype. Browse the fictional catalog, open an album, and tap the mini-player to open Now Playing. Playback, favorites, queue state, and the selected output persist locally.

## Run locally

Use Node.js 22.13 or newer and install the dependencies.

```sh
npm ci
npx expo start --go
```

With an SDK 58-compatible Expo Go installed, press `i` in the Expo terminal to preview on an iOS simulator. To build the standalone app in Xcode, run `npm run ios`. The system Liquid Glass tab bar and mini-player accessory require iOS 26 or later.

## Try the prototype

- Tap the mini-player to expand it. Tap the grabber or swipe down across the artwork or song details to collapse it back into the mini-player.
- Swipe left on Now Playing for the next track or right for the previous-track action. The Lyrics and Queue buttons sit below the volume slider. Tap either button again to return to the artwork.
- In Queue, pull the list down to reveal tracks played earlier. Scroll past Up Next for Autoplay. Drag a reorder handle, or swipe left on a track for Play Next and Remove.
- Open any album and tap the heart next to a song’s overflow button. Find it again in Library under Liked Songs.
- Open Playback Device from the mini-player or Now Playing to move the simulated output. Use Preview Remote Controls in the device sheet to control the same session from a simulated MacBook.

The playback clock, music catalog, lyrics, autoplay, and device switching are demo data and behavior. The prototype does not stream audio, connect to physical playback devices, or synchronize separate app installations.

## Verify

```sh
npm run typecheck
npx expo export --platform ios
```
