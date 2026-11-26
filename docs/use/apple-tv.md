# The Apple TV app

Squirmy on Apple TV plays music from your server over the shared playback session. Use the Siri Remote to browse your library, search for music, read lyrics and manage the queue. You can also control the TV's session from Squirmy on your phone or in a browser.

## Install with TestFlight

Open your Squirmy TestFlight invitation on an iPhone or iPad signed into the same Apple Account as your Apple TV. Install **TestFlight** from the App Store on Apple TV, then choose **Squirmy → Install** once a tvOS build is available to your tester group. If the invitation gives you a redemption code, enter it in TestFlight on Apple TV. [Apple's TestFlight instructions](https://testflight.apple.com/)

## Connect and sign in

1. Type the address of your Squirmy server, such as `music.example.com` or `http://192.168.1.20:4747` on your home network.
2. Choose **Continue**. If Apple TV asks for Local Network access, allow it so the app can reach a server on your network.
3. Type your existing Squirmy username and password. If Apple TV offers its keyboard notification on your iPhone, you can use it to type.

Use the web app to [set up the server](../server/quick-start.md) or [create an account from an invite](../server/users.md) before signing in. For a remote server, use [HTTPS](../server/reverse-proxy.md). To connect to a different server, open **Settings**.

## Browse and play

- **Home** surfaces recent music and playlists. **Library** shows your albums, artists, playlists and songs. Use **Search** to look up music in your library and the catalog. The heart saves an item to your library, and dimmed tracks indicate music that can't currently play.
- Open **Now Playing** for transport, synced lyrics and the queue. Press Play/Pause on the Siri Remote to control the shared session. Use the focusable seek controls to move within a track.
- Use **Devices** in Now Playing to transfer playback to Apple TV. While another device plays, Apple TV controls that session. To start sound on the TV, choose **This Apple TV**. [Devices and transferring playback](../server/playback.md#devices-and-transferring-playback)

## Build from source

On a Mac with Xcode's tvOS SDK installed, use the repository root to install dependencies and build the shared packages. Then generate and compile the native TV project.

```sh
npm ci
npm run build:packages
cd apps/mobile
export EXPO_TV=1
npx expo prebuild --platform ios --clean
xcodebuild -workspace ios/Squirmy.xcworkspace -scheme Squirmy \
  -configuration Release -destination 'generic/platform=tvOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The tvOS project lives in `apps/mobile/ios`. To build again for iPhone, unset `EXPO_TV` and regenerate the native project with `npx expo prebuild --platform ios --clean`.
