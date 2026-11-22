# Metadata and privacy

Squirmy identifies music and fills in covers, images, biographies and lyrics by asking public services. This page lists every service the server can contact, exactly what it sends, and how to turn each off. It also covers the API keys you can add and the optional local search index.

## Who talks to whom

The web app and the iOS app talk only to your server. Covers and artist images are downloaded by the server and served from `/api/v1/art`, so a listener's browser or phone never contacts a third party for them. The server downloads images only over HTTPS and only from public addresses, never from your own machine or network, whatever a link in a service's data points to. (Some admin screens link to MusicBrainz pages, which open only if you click them.)

The server contacts the services below. Each sees the server's IP address and this User-Agent, which names the software but nothing about you or your users:

```
Squirmy/<version> ( https://github.com/IsaacThoman/squirmy )
```

Responses are cached in the database (`http_cache`), so the same question is not asked twice for a while: MusicBrainz lookups for a week, searches for a day.

## Every external service

| Service | Contacted when | What is sent | Default | Turn it off |
|---|---|---|---|---|
| **MusicBrainz** (`musicbrainz.org`, or your mirror) | Identifying albums after a scan or import; **Fix match** searches; opening an artist or album page; catalog search when Deezer is off and there is no local index | Album artist and title, track counts, barcodes and ISRCs from your tags, MusicBrainz ids, Deezer links and barcodes being bridged to MusicBrainz, and the search text an admin types in Fix match (or any user's search text, when it answers catalog search) | On | **Admin → Server settings → MusicBrainz**. Nothing new is identified while it is off; switching it back on starts on what waited. |
| **Cover Art Archive** (`coverartarchive.org`, images served from `archive.org`) | Fetching covers for identified albums, and for albums you browse | MusicBrainz release and release-group ids | On | **Cover Art Archive** |
| **Deezer** (`api.deezer.com`, images from Deezer's image servers) | **Every catalog search**, as users type, unless the local search index is ready; artist pages; covers MusicBrainz lacks; radio | Users' search text; artist names; album barcodes (UPC); ISRCs; Deezer ids | On | **Deezer**. Catalog search then falls back to MusicBrainz, which matches titles only. |
| **Wikidata, Wikipedia, Wikimedia Commons** | Artist images and biographies, album descriptions | Wikidata ids taken from MusicBrainz, Wikipedia page titles | On | **Wikidata and Wikipedia** |
| **LRCLIB** (`lrclib.net`) | Lyrics for owned tracks without lyrics in the file or a `.lrc` file, and when lyrics are opened | Track title, artist, album and length | On | **LRCLIB** |
| **ListenBrainz** (`api.listenbrainz.org`, `labs.api.listenbrainz.org`) | With a server token: artist pages (top songs, popularity) and radio (similar artists) | MusicBrainz artist and recording ids, the server token | Off until an admin adds a token | **API keys → ListenBrainz → Remove key** |
| **ListenBrainz**, per user | A user connects ListenBrainz in their settings | That user's plays: title, artist, album, track number, length, start time, MusicBrainz ids, with the user's own token | Off until a user connects | The user disconnects it |
| **AcoustID** (`api.acoustid.org`) | Identifying files that have no album and artist tags | An audio fingerprint (computed on the server with `fpcalc`) and the length, with the key | Off until an admin adds a key | **API keys → AcoustID → Remove key** |
| **fanart.tv** (`webservice.fanart.tv`, `assets.fanart.tv`) | Artist images | MusicBrainz artist ids, the key | Off until an admin adds a key | **API keys → fanart.tv → Remove key** |
| **Last.fm** (`ws.audioscrobbler.com`) | A user connects Last.fm; plays and "now playing" for connected users | That user's plays and current track: title, artist, album, track number, length, start time, MusicBrainz ids | Off until an admin adds a key and a user connects | Remove the key, or the user disconnects |
| **MetaBrainz data** (`data.metabrainz.org`) | Only when an admin starts a **Search index** import | Nothing beyond the download request | Off | Do not start an import |
| **Acquisition providers** (addresses you add) | Only after an admin adds one | Title, artist, length, album and ids of tracks being shown or requested | Off | See [Acquisition providers](./acquisition.md) |

Turning a service off stops new requests to it. What it already provided (covers, ids, lyrics) stays.

To run a server that sends nothing about your library anywhere, turn off all five sources under **Metadata sources** and add no keys. Music then stays as its tags describe it ("From tags only"), with embedded and folder artwork, embedded and `.lrc` lyrics, and search over your own library.

## API keys

Add these in **Admin → Server settings → API keys** with **Add key**. They are stored encrypted with the server secret and never shown again.

| Key | Where to get it | What it unlocks |
|---|---|---|
| **ListenBrainz** user token | Your ListenBrainz profile settings | Top songs and popularity on artist pages, similar artists for radio and Subsonic "similar songs". Not needed for users to scrobble to ListenBrainz. |
| **AcoustID** API key | An application key from acoustid.org | Identifying untagged files (no album or artist tags) by their audio fingerprint. Untagged files already in the library are tried again when the key is added ([Turning identification on later](./library.md#turning-identification-on-later)). |
| **fanart.tv** API key | A personal or project key from fanart.tv | Better artist images. |
| **Last.fm** API key and shared secret | A Last.fm API account | Lets users connect their Last.fm account for scrobbling. See [Scrobbling](./scrobbling.md). |

## The MusicBrainz rate limit

The public MusicBrainz server allows about one request per second per client. Squirmy spaces its requests 1.1 seconds apart, across every process, and only for `musicbrainz.org`.

For a large library, that is the bottleneck. Identifying an album and fetching its details takes several requests (on the demo library, about seven per album), so a first scan of 1,000 albums takes a few hours and 10,000 albums more than a day. The music is playable from its tags the whole time, and the work survives restarts.

If you run your own [MusicBrainz mirror](https://musicbrainz.org/doc/MusicBrainz_Server/Setup), enter its base URL (for example `http://musicbrainz-mirror:5000`) in **Admin → Server settings → MusicBrainz server**. Requests to anything other than `musicbrainz.org` are not rate limited.

## The local search index

Catalog search (finding music you do not own) normally asks Deezer as users type. The local search index is an optional copy of MusicBrainz's catalog in your own database, so searching for any artist, album or song is answered on your server in milliseconds and no search text leaves it.

It is worth it when you want search to stay private, when you turned Deezer off, or when you want catalog search that does not depend on an outside service. It costs disk space and an import:

| | Full catalog |
|---|---|
| Download | about 2.4 GB, from `data.metabrainz.org` |
| Disk once imported | about 7 GB in Postgres |
| Free space needed while importing | about 20 GB more |
| Time | 7 to 10 minutes on a fast laptop; plan on 30 to 60 minutes on a modest server, plus the download |

To set it up:

1. Open **Admin → Search index**.
2. Under **Dump**, keep **The newest dump from MetaBrainz**, or choose **A URL or a file on this server** for a `.tar.zst` dump you downloaded yourself.
3. Under **Size**, keep **Every recording**, or choose **Fewer songs for the biggest artists** and a number to save space. Artists and albums stay complete either way.
4. Choose **Start import**. Progress shows on the page; the import runs in the background at low priority.

Search keeps using Deezer until the index is ready, then uses the index first. To refresh it, choose **Import again**; search keeps answering from the current index until the new one is complete. **Remove** empties it. MetaBrainz publishes a new dump about every two weeks, and the data is CC0.

The index only answers search. Artist images, top songs and covers for music you do not own still come from the services above. The design and measurements are in [Local search index](../local-search-index.md).
