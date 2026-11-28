# Share links

Members can make public links to albums, playlists and songs (see [Sharing music](../use/sharing.md)). Anyone with a link opens a page in a browser, without an account. This page covers the two settings that control it and the list of every link.

## Settings

Both are in **Admin → Sharing** in the web app, and in `PATCH /api/v1/admin/settings` (see [Server settings](./configuration.md#server-settings)).

| Setting (as on screen) | Key | Default | What it does |
|---|---|---|---|
| Share links | `sharingEnabled` | on | Off, every link stops working at once (it answers "This link doesn't work") and nothing offers Share. Links are kept, so turning it back on brings them back. |
| What a shared page plays | `sharePlayback` | `previews` | `previews`: the first 30 seconds of each song. `full`: whole songs. `off`: the page lists the songs but plays nothing. |

```sh
curl -X PATCH https://music.example.com/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sharingEnabled": true, "sharePlayback": "full"}'
```

Changing either takes effect for audio already playing from a link: switching from `full` to `previews` or `off` stops whole songs mid-play.

Previews are cut by the server: each is a separate 30-second MP3 made the first time it is played and kept in `<data>/previews/` for a week after its last play. A listener cannot get more than the preview, whatever they ask for. Whole songs play at the apps' **High** quality (AAC 256 kbps) when the file is lossless or larger. Only music the server holds plays; a song an acquisition provider could fetch shows as not available. When the server has [several copies](./library.md#several-copies-of-one-album) of an album or song, a link lists and plays the version its creator picked.

A link follows its creator's [explicit content](./users.md#explicit-content) switch: while it is off for them, explicit songs show as **Not available** on their links and do not play, links and song URLs already handed out included. With it on, explicit songs play from a link like any other, marked **E**; visitors have no switch of their own.

## Every link

**Admin → Sharing → Every link** lists the links on the server, newest first, with who made each, when it expires and how often it was opened. **Revoke** stops one for everyone. Members see and revoke their own in **Settings → Share links**.

## What a link exposes

The page shows the item's title, artist, year and cover, and for each song its title, artist, album (in a playlist), length and whether it plays. It shows no usernames, no playlist descriptions, no file names or paths, and no other part of the library.

- A link's token is 256 random bits. The server stores only its SHA-256, so a copy of the database cannot be turned back into working links.
- Unknown, expired, revoked and switched-off links all answer the same 404.
- The public routes are rate limited per address (IPv6 per /64): 60 page loads, 120 song starts and 600 audio requests a minute. Behind a reverse proxy, set `TRUST_PROXY` so the limits see the visitor's address (see [What `TRUST_PROXY` does](./reverse-proxy.md#what-trust-proxy-does)).
- Audio plays through URLs that expire after three hours and name neither the file nor the link; every request checks the link is still live.
