# The Apple TV app

Squirmy on Apple TV plays the music on your server through your shared playback session, so it picks up where your phone or browser left off. Everything works with the Siri Remote: the clickpad moves focus and selects, **Back** (or **Menu**) goes back, and holding the click opens a menu. The app needs tvOS 17 or later.

## Install with TestFlight

Open your Squirmy TestFlight invitation on an iPhone or iPad signed into the same Apple Account as your Apple TV. Install **TestFlight** from the App Store on Apple TV, then choose **Squirmy → Install** once a tvOS build is available to your tester group. If the invitation gives you a redemption code, enter it in TestFlight on Apple TV. [Apple's TestFlight instructions](https://testflight.apple.com/)

## Connect and sign in

1. Select **Server address** and type the address of your Squirmy server, such as `music.example.com` or `http://192.168.1.20:4747` on your home network. Choose **Continue**. If Apple TV asks for Local Network access, allow it so the app can reach a server on your network.
2. Type your Squirmy username and password and choose **Sign In**. With an invite code you can choose **Create Account** instead.

When a field opens the keyboard, Apple TV also offers it on your iPhone: accept the notification and type there. Use the web app to [set up the server](../server/quick-start.md) or [create an account from an invite](../server/users.md) first if you need to. For a server outside your home, use [HTTPS](../server/reverse-proxy.md).

## Getting around

The tabs are in the sidebar at the left, as in Apple's own apps: **Search**, **Home**, **Library**, **Now Playing** and **Settings**. Once you browse into a page the sidebar folds away; press **Back** on a tab's first page to bring it back.

- **Home** has the same rows as the phone, as rows of covers: **Jump back in**, your mixes under **Made for you**, the artists you play and artists like them, your playlists and what is new on the server ([Home](./web.md#home)). Choose a mix for its songs, with **Play** and **Shuffle**.
- **Library** has your albums, artists, playlists and songs.
- **Search** searches your library and the catalog as you type, with the one-row tvOS keyboard or your iPhone.

Select a cover to open its album, artist or playlist. Songs that can't play right now are dimmed.

## Playing music

Select a song to play it, or **Play** or the shuffle button at the top of an album or playlist. The Play/Pause button on the remote plays and pauses from anywhere in the app.

Hold the click on a song or an album for its menu. A song's has **Play next**, **Add to queue**, **Add to playlist**, **Start radio**, saving it to your library, and going to its album or artist; an album's plays, shuffles or queues it, adds it to a playlist, or goes to its artist. These are the same actions as the long-press menus on the phone. An album page's **⋯** button opens its menu too.

## Now Playing

**Now Playing** shows the cover of the song playing among the songs around it, over a backdrop made from its colors. Left alone, the controls fade away and leave the covers; press any direction to bring them back.

- Focus the progress bar and press left or right to skip back or ahead ten seconds a press, longer while held. Select plays and pauses.
- The buttons above it turn on **Shuffle**, **Repeat** and **Autoplay**, heart the song and open its menu. The menu's **Track info** shows the song's file, how it reaches the device playing, and the volume normalization applied; press Menu or **Done** to close it.
- The song's menu ends with **Sleep timer**: stop playing after 5 to 60 minutes, at the end of the song, or at the end of the album, playlist or queue, or **Turn off timer**. While one is set, a moon and the time left show at the start of that row. The timer is your session's, so one set on your phone stops the Apple TV too. See [Sleep timer](../server/playback.md#sleep-timer).
- Under the song, **Lossless** or **Hi-Res Lossless** shows while the device playing gets a lossless file as it is.
- **Lyrics** shows the words beside the cover, the line being sung highlighted. **Up Next** shows the queue: select a song to play it, or hold the click to move it or remove it.

## Your phone and other devices

The Apple TV is one of your devices, like your phone and your browser, and they all play one session.

- **Move the music to the TV.** In Now Playing, choose the playback device button at the bottom left and select this Apple TV in the list. It carries on from where it was. From your phone or the web app you can also choose the Apple TV under **Playback device** or **Devices**.
- **Use your phone as a remote.** While the TV plays, Squirmy on your phone or in a browser controls it: play, pause, skip, change the queue or the volume.
- **Use the TV as a remote.** While another device plays, the TV's Now Playing says where and controls it.
- **AirPlay.** While the Apple TV plays, the playback device panel has **AirPlay**, which opens the system's picker to send the TV's sound to AirPlay speakers, as the system's music app does. Choosing which of your devices plays is the list above it.
- **Play separately.** In the playback device panel, **Play separately on this Apple TV** gives the TV its own queue while your other devices keep theirs, and **Rejoin your other devices** brings it back. [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback)

## Settings

**Settings** shows who is signed in and to which server, with **Sign Out**. Under **Profiles** are the household's other accounts on this Apple TV, on any server: select one to switch to it, still signed in (one that was signed out opens at its sign-in), or hold it and choose **Remove Profile**. **Add Profile** signs in to another server, or as someone else on this one, and keeps the profile in use signed in. Switching stops what the Apple TV was playing; each profile keeps its own streaming cache. Under **Playback** are **Volume Normalization** and **Streaming Quality**; the Apple TV streams at your Wi-Fi quality, over Ethernet too, and these settings are your account's, so they change on your phone as well. **Library** has the switch that shows all of this server's music in your library. TestFlight and development builds also have **Engine**, which switches between the classic engine and Squirmy's own, gapless one for this Apple TV, from the next time the app opens. **Library** has the switch that shows all of this server's music in your library.

**Scrobbling** shows whether ListenBrainz and Last.fm are connected, and turns a connected service on or off; hold the click on one to disconnect it. Connecting needs a sign-in page or a token, so connect them in Squirmy on your iPhone or in the web app ([scrobbling](../server/scrobbling.md)). **About** has the app's and the server's versions, for bug reports.

## Build from source

On a Mac with Xcode and its tvOS platform installed, install dependencies and build the shared packages from the repository root, then generate and build the TV project:

```sh
npm ci
npm run build:packages
cd apps/mobile
npm run tv:prebuild
npm run tv
```

`npm run tv:prebuild` runs `expo prebuild` with `EXPO_TV=1`, which makes `apps/mobile/ios` the tvOS project, and `npm run tv` builds it and runs it on an Apple TV or simulator. To install on your own Apple TV, pair it with Xcode (**Window → Devices and Simulators**), open `ios/Squirmy.xcworkspace`, set your team and your own bundle identifier under **Signing & Capabilities**, and run the **Squirmy** scheme in the Release configuration.

The same `ios` folder holds the iPhone project when you build that, so run `npm run ios:prebuild` before building for iPhone again, and `npm run tv:prebuild` to come back.
