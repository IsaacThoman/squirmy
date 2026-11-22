---
layout: home
titleTemplate: false

hero:
  name: Squirmy
  text: Your music server
  tagline: A self-hosted music server with a web app and an iOS app. It identifies and organizes your files, searches all music, and keeps one playback session in step across your devices.
  actions:
    - theme: brand
      text: Quick start
      link: /server/quick-start
    - theme: alt
      text: Configuration
      link: /server/configuration
    - theme: alt
      text: GitHub
      link: https://github.com/IsaacThoman/squirmy

features:
  - title: Your files, identified
    details: Squirmy reads your tags, matches albums against MusicBrainz, fetches covers and lyrics, and can rename managed folders into a clean layout. Every move can be previewed and undone.
    link: /server/library
  - title: Search everything
    details: Search covers all music, not only what you own. Your library comes first at full brightness; everything else shows gray and can go on your wantlist.
    link: /use/web
  - title: One session, every device
    details: Playback lives on the server. Start an album in the browser, pick it up on your phone, or use one as a remote for the other.
    link: /server/playback
  - title: Works with Subsonic apps
    details: An OpenSubsonic API under /rest lets apps written for Subsonic and Navidrome play your library with their own app passwords.
    link: /server/subsonic
---

<!-- Screenshots: the maintainer adds images of the web app and the iOS app here. -->

## A running server in a minute

You need Docker with Compose. The image is published for amd64 and arm64, so all you download is the Compose file.

```sh
mkdir squirmy && cd squirmy
curl -fsSLO https://raw.githubusercontent.com/IsaacThoman/squirmy/main/compose.yaml
MUSIC_DIR=/path/to/your/music docker compose up -d
```

Open `http://localhost:4747`, create the admin account, and choose **Continue** at the folder step: your music folder is already listed there, added and scanning. The [quick start](/server/quick-start) explains every step, what the first scan does and how long identification takes.

## Where to go next

- **Running a server:** [Quick start](/server/quick-start), [Configuration](/server/configuration), [Reverse proxies and HTTPS](/server/reverse-proxy), [Backup](/server/backup), [Troubleshooting](/server/troubleshooting).
- **Your music:** [Your library](/server/library), [Organizing files](/server/organizing), [Adding music](/server/adding-music), [Metadata and privacy](/server/metadata-and-privacy).
- **Using it:** [The web app](/use/web), [The iOS app](/use/ios), [Subsonic clients](/server/subsonic).
- **Status:** Squirmy is young. The [roadmap](/roadmap) lists what works today and what does not yet.
