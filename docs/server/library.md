# Your library

This page covers adding music folders, how Squirmy finds changes in them, how files become albums, and what to do with albums it could not identify. Everything here is in **Admin → Library** and **Admin → Review queue**.

## Music folders

A library folder is a directory on the server that Squirmy scans. Every user shares the same library; likes, playlists, history and playback are each person's own.

Each folder is one of two kinds:

| | Read-only (default) | Managed |
|---|---|---|
| Squirmy reads tags and plays the files | yes | yes |
| Squirmy renames and moves files | never | only when you apply an organize batch |
| Squirmy writes tags into files | never | only when you ask for it in an organize batch |
| Uploads and acquired music can be filed into it | no | yes |

Folders added from `SQUIRMY_LIBRARY_PATHS` (in Docker, `/music`) start read-only; folders added from `SQUIRMY_MANAGED_LIBRARY_PATHS` start managed ([configuration](./configuration.md#environment-variables)). [Organizing files](./organizing.md) explains managed folders.

### Add a folder

1. Open **Admin → Library** and choose **Add folder**.
2. Pick the folder in the browser, or type its path into the path field and press Enter. The folder shown on screen is the one that is added. The browser starts in the server's home folder; in Docker that is inside the container, so the folder must be mounted into the container first (add a line under `volumes:` in `compose.yaml`, for example `- /srv/more-music:/more-music:ro`, and run `docker compose up -d`).
3. Give it a name, and decide on **Let Squirmy organize this folder** (managed) and **Watch for changes**.
4. Choose **Add and scan**.

A folder cannot be inside another library folder or contain one: every file belongs to exactly one folder.

### Change or remove a folder

Each folder's **⋯** menu has **Scan now**, **Edit…** (name, managed, watching, enabled), **Disable** and **Remove folder…**.

- **Disable** stops scanning and watching it. Its music stays in the library.
- **Remove folder…** takes its files out of the library. Nothing on disk is moved, renamed or deleted, and adding the folder again brings the music back. Likes and playlists point at the catalog, not at files, so they come back too.

## Scanning and watching

A scan walks the folder and compares every file's path, size and modification time with what the library knows: new files are read, changed ones are read again, vanished ones are marked missing.

Scans happen:

- when a folder is added, and on **Scan now**;
- every night at 04:00 UTC, for every enabled folder;
- for just the changed paths, two seconds after changes stop, while **Watch for changes** is on.

Hidden files and folders, partial downloads, Synology `@eaDir`, `#recycle` and `#snapshot`, `$RECYCLE.BIN`, `System Volume Information` and `lost+found` are skipped. Symbolic links are followed only to files inside the folder.

### When watching does not work

Watching relies on the operating system's change notifications, and fails quietly where they do not exist. The nightly scan and **Scan now** always work.

- **Network mounts (NFS, SMB/CIFS, 9p, Ceph) are not watched.** Notifications do not report changes made by other machines, so Squirmy does not try; the log says "Not watching … it is a network mount". New music on a NAS appears after the nightly scan or when you choose **Scan now**.
- **Linux inotify limits.** Squirmy uses one inotify watch per folder. A very large library can exceed `fs.inotify.max_user_watches`; the log warns once and that folder stops being watched. Raise the limit on the host (for example `sysctl fs.inotify.max_user_watches=524288`).
- **Docker Desktop on macOS and Windows.** Bind mounts from the host may not deliver change events into the container. Use **Scan now**.

## How files become albums

Files are grouped by folder, album tag and album artist tag:

- Files in the same folder with the same album and album artist are one album. Disc subfolders (`CD1`, `Disc 2`, `disk3`, `CD 1 - Bonus`) count as their parent folder, so a two-disc set in `Album/CD1` and `Album/CD2` is one album.
- Files with no album tag but the same artist in one folder become one album named after the folder; a lone file becomes a single named after its title.
- A file with neither album nor artist tags is a single of its own.
- "Artist feat. Other" is split into a main and a featured artist. `&`, `,` and `/` are never split, because they are part of too many names.

The exact rules are written out at the top of `apps/server/src/modules/library/grouping.ts`.

Squirmy also recognizes a file by a hash of its audio stream, computed without decoding. Moving or retagging a file therefore keeps its identity, its match and everything that points at it.

## Missing files and the grace period

A file that disappears is marked **missing** rather than deleted from the library, so an unmounted drive or a NAS that is offline for a weekend does not empty your library. After **Keep missing files for** (default 14 days, in **Admin → Server settings → Library**) a daily job at 05:30 UTC removes it. A file that comes back before then simply returns.

A folder the server cannot read at all (the mount is gone and the path does not exist) is skipped during the scan, and its files are not marked missing. If the mount point still exists but is empty, the files are marked missing and the grace period protects them.

The **Missing from disk** count under **Identification** in **Admin → Library** shows how many files are missing right now.

## Identified, in review, from tags only

**Admin → Library** counts files in four states:

| On screen | Meaning |
|---|---|
| **Identified** | Matched to a MusicBrainz release, with a score at or above **Accept matches automatically above** (default 90%), or chosen by an admin. |
| **In review** | The best candidate scored between 50% and the threshold. It waits in the review queue for an admin. |
| **From tags only** | Nothing scored 50% or more, MusicBrainz is off, or an admin chose to keep the album as its tags describe it. The album is still browsable and playable, built from its tags, with no MusicBrainz id. |
| **Waiting** | Not tried yet. Albums waiting are retried every 10 minutes. |

How an album is matched, in order:

1. MusicBrainz ids already in the tags (as written by Picard and most taggers).
2. A search for the album artist and title, scored on track count, titles, lengths and year.
3. For files with no album and artist tags, and only when an [AcoustID key](./metadata-and-privacy.md#api-keys) is set: the audio fingerprint.

Music plays the whole time, whatever its state.

## The review queue and Fix match

**Admin → Review queue** lists the albums the matcher was not sure about, with a count in the admin menu. Pick an album to see its files ("The tags say") beside each candidate release, with a track-by-track comparison and a score.

- **Use this release** applies the candidate.
- **Keep as it is** keeps the album as its tags describe it.
- **Dismiss** closes the review and leaves the album unidentified.
- **Search** looks for other candidates.

Whatever you choose with **Use this release** or **Keep as it is** is locked: later scans and automatic matching never change it.

**Fix match** corrects any album, identified or not. Open it with **Fix a match** in **Admin → Library** (then find the album), from a review, or from an album in **Admin → Organize**. In the dialog you can:

- search MusicBrainz by "Artist - Album", a title, a MusicBrainz release or release-group link, or an MBID, and choose **Use this release**;
- **Match automatically**, to unlock the album and let the matcher try again;
- **Use the tags**, to keep it as its tags describe it.

Searching uses the public MusicBrainz server, which answers one request a second, so results can take a few seconds.
