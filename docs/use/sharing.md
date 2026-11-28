# Sharing music

A share link is a public page for an album, a playlist or a song. Anyone you send it to can open it in a browser without an account: they see the cover, the title, the artist and the songs with their lengths, and can listen as far as the server allows.

## Making a link

- **Web app.** Choose **Share…** in the **⋯** menu of an album (on its page, its card or a search result), a playlist (on its page or a search result) or a song (in any song list). Pick how long the link works (**1 day**, **7 days**, **30 days** or **Until I revoke it**), choose **Create link**, then **Copy**.
- **iOS app.** Choose **Share** on an album's or playlist's page, or in a song's menu. Pick how long the link works, and the share sheet opens with the link in it.

The link looks like `https://music.example.com/s/…`. Copy it when it is made: the server keeps only a fingerprint of it, so it cannot show you the same link again. If you lose it, make a new one.

You can share any album or song on the server, your own playlists, and other people's public playlists. While the server's admin has sharing turned off, nothing offers Share (the iOS app's Share button sends the name only, as before).

## What people see

- The page shows what the item holds **now**. A shared playlist follows your changes: songs you add appear on the page, songs you remove leave it.
- Songs the server has no file of are listed as **Not available** and do not play. Nothing is fetched for people opening a link.
- Depending on the server, a song plays as a **30-second preview**, in full, or not at all. The page says which.
- Nothing about you is on the page: not your name, not the playlist's description, and nothing else from the server's library. A playlist shows only its name and its songs.

## Managing your links

In the web app, open **Settings → Share links**. Each link shows what it points at, when it was made, when it expires and how often it was opened. **Revoke** stops a link at once for everyone who has it, including songs already playing from it.

A link also stops working when it expires, when a shared playlist is deleted or (for someone else's playlist) made private, when your account is disabled or deleted, and while the admin has sharing turned off. Every link that does not work shows the same page: "This link doesn't work". Expired links stay listed for 30 days, marked **Expired**, then disappear.
