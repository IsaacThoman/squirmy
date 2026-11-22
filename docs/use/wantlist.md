# The wantlist

The wantlist is your list of albums and songs you do not have yet. Add gray music to it while you browse, and it fills in when matching music arrives on the server.

## Turning it on

The wantlist is off unless the server's admin turns it on, and while it is off the apps do not mention it. It is most useful when music reaches the server by hand; with an [acquisition provider](../server/acquisition.md) that can fetch anything, playing a song is quicker than wanting it.

An admin turns it on in the web app, in **Admin → Server settings → General → Wantlist**, or with the `wantlistEnabled` setting (see [Server settings](../server/configuration.md#server-settings)):

```sh
curl -X PATCH https://music.example.com/api/v1/admin/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"wantlistEnabled": true}'
```

Open apps show or hide it right away. Turning it off keeps everyone's wants, so turning it back on brings them back.

## Adding to it

- **Web app.** Albums you do not have show a bookmark on their cards, and album pages and song menus have **Add to Wantlist**. Search results below "your library" and gray albums on artist pages are the usual places to find them.
- **iOS app.** Album pages for albums you do not fully own have **Add to wantlist**, and song menus for songs you do not have offer **Add to wantlist**.

Remove an item with **Remove from Wantlist** in the same places. Each person has their own wantlist.

## Seeing it

- **Web app:** **Wantlist** in the sidebar lists your albums and songs.
- **Home** (web and iOS) has a **Wantlist** row while anything on it is still missing.

## How it fills in

A wanted album counts as fulfilled once every track of it is on the server, and a wanted song once it is on the server, however the music arrived: a scan of a library folder, an [upload or the inbox](../server/adding-music.md), or an [acquisition provider](../server/acquisition.md). It has to be identified as the same album or recording to count, so music that stays "From tags only" does not complete a want until it is matched (see [Fix match](../server/library.md#the-review-queue-and-fix-match)).

A fulfilled item stays on the list but leaves Home's row. Wanting something does not fetch it: it is a list for you, and for whoever adds music to the server.
