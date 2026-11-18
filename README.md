# TONE

TONE is an iOS-first Expo music prototype. Browse the fictional catalog, open an album, and tap the mini-player to open Now Playing. Playback, favorites, queue state, and the selected output persist locally.

## Run locally

Use Node.js 22.13 or newer and install the dependencies.

```sh
npm ci
npm run ios
```

The iOS command builds and launches the app using Xcode. iOS 26 or later brings the system Liquid Glass tab bar and mini-player accessory. You can also run the project as a development server with `npm start`.

## Try the prototype

- Swipe horizontally between Lyrics, Now Playing, and Queue. The footer buttons are another way to switch views.
- In Queue, pull the list down to reveal tracks played earlier. Scroll past Up Next for Autoplay. Drag a reorder handle, or swipe left on a track for Play Next and Remove.
- Open any album and tap the heart next to a song’s overflow button. Find it again in Library under Liked Songs.
- Open Playback Device from the mini-player or Now Playing to move the simulated output. Use Preview Remote Controls in the device sheet to control the same session from a simulated MacBook.

The playback clock, music catalog, lyrics, autoplay, and device switching are demo data and behavior. The prototype does not stream audio, connect to physical playback devices, or synchronize separate app installations.

## Verify

```sh
npm run typecheck
npx expo export --platform ios
```
