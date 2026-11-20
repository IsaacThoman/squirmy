# Organizing files

In a managed folder Squirmy can rename and move identified music into a consistent layout, and write the identified tags into the files. This page covers making a folder managed, the naming template, previewing and applying a batch, undoing it, and what tag writing checks before it touches a file.

Nothing in a folder changes until you preview a batch and apply it, and every batch can be undone. Read-only folders are never changed.

## Make a folder managed

1. Make sure the folder is writable by the server. In Docker, the container user is uid 1000, and the volume must not end in `:ro`.
2. In **Admin → Library**, open the folder's **⋯** menu, choose **Edit…**, turn on **Let Squirmy organize this folder**, and **Save**.
3. Confirm with **Make managed**.

Or turn on **Let Squirmy organize this folder** when you add the folder.

## The naming template

Each managed folder has its own naming template. Unless you set one, it uses the default:

```
{albumartist}/{album}[ ({year})]/[[{disc}-]{track} ]{title}.{ext}
```

which gives paths like:

```
Radiohead/OK Computer (1997)/01 Airbag.flac
Pink Floyd/The Wall (1979)/2-01 Hey You.flac
Various Artists/Some Compilation/07 Some Song.mp3
```

| Token | Value |
|---|---|
| `{albumartist}` | The album's artist credit, or `Various Artists` for a compilation. |
| `{artist}` | The track's artist credit. |
| `{album}` | The album title. |
| `{year}` | The album's year. |
| `{disc}` | The disc number, only on releases with more than one disc. |
| `{track}` | The track number, zero-padded to at least two digits. |
| `{title}` | The track title. |
| `{ext}` | The file's extension, lowercase. |

Text in square brackets is left out when a token inside it has no value: an album without a year gets no `()`, and a single-disc album gets no disc prefix.

Each folder and file name is made safe for Linux, macOS, Windows and SMB shares: the characters `< > : " / \ | ? *` become `_`, leading dots and trailing dots or spaces are removed, Windows device names such as `CON` get a `_`, and each name is cut to 200 bytes. Folder names reuse the spelling of a folder that already exists, so "abba" and "ABBA" share one folder. When two files would land on the same name, one keeps it and the others get ` (2)`, ` (3)` and so on.

### Changing the template

A template is a path of literal text, tokens and `[optional]` parts, separated by `/`. The rules:

- The file name (after the last `/`) must contain `{title}` and end with `.{ext}`, and `{ext}` may appear nowhere else.
- Square brackets must contain a token and may not contain `/`.
- No empty folder names (`//`, or a `/` at either end), no `.` or `..` folders, and none of `< > : " \ | ? *` or control characters.
- At most 500 characters.

To change it, open **Admin → Library**, choose the managed folder's **⋯** menu, then **Edit…**. **Naming template** shows the folder's template, marked **Default** while it uses the default. Edit it in place: under the field, an example shows the path a track on a two-disc album would get, and **Tokens** lists every token with its description. **Save** checks the template; one that breaks a rule is refused with the reason under the field, for example `The file name must end with .{ext}`. **Reset to default** goes back to the default. A preview on **Organize** says whether it used the default template or the folder's own, with **Change it in Library** to open this editor.

Through the API, the template is the folder's `template` field: `POST /api/v1/admin/library/roots` when adding a folder, or `PATCH /api/v1/admin/library/roots/<id>` later, with `null` for the default. A refused template is error code `invalid_request` with the reason. `GET /api/v1/admin/organize/template` returns the default template and the tokens with their descriptions.

Changing the template moves nothing by itself: the next preview plans moves to the new layout. A batch already previewed keeps the template it was planned with.

## Preview, apply, undo

Open **Admin → Organize**. With more than one managed folder, choose it under **Folder**.

1. Choose the options:
   - **Include unidentified music**: also file albums that are not identified, named from their own tags. Off (the default) moves only identified albums and albums an admin approved.
   - **Write tags**: write the identified title, artists, album, track and disc numbers, year, genres, MusicBrainz ids and measured ReplayGain values into the files.
2. Choose **Preview**. Squirmy plans where every file should go and shows each album with its moves (current path, then where it moves to). Nothing has changed on disk yet. Files that are already in place are not listed; "Tags only, stays in place" means a file only gets tags. A skipped move says why.
3. Apply all of it with **Apply all**, or tick albums and choose **Apply N albums**. The batch runs in the background, and progress shows on the page; you can leave it.

Covers, booklets, `.cue`, `.log`, `.lrc` and playlist files travel with their album when every audio file in their folder moves to the same new folder. Empty folders left behind are removed.

Moves are safe against crashes and full disks: within one file system a file is renamed; across file systems it is copied next to its destination, checked byte for byte, moved into place, and only then is the original deleted. A file that already exists at the destination is never replaced.

**History** lists past batches. **Undo** on an applied batch moves its files back to where they were and removes the folders it created once they are empty.

::: warning Undo does not remove tags
Undo moves files back. Tags written by the batch stay written.
:::

## Tag writing and its safety checks

Tags are written only in batches with **Write tags** on, and only into these formats, which passed round-trip tests with the tag library: **FLAC, MP3, M4A (AAC and ALAC), Ogg Vorbis (`.ogg`) and Opus**. Other files are moved but not tagged, with the reason shown.

For each file:

1. The audio stream's hash is computed and compared with what the library has on record. A file that is not the one the library knows is left alone.
2. The tags are written into a copy in the same folder, never into the original.
3. The copy is read back. Every written field must read back as written.
4. The copy's audio hash must equal the original's: writing tags must not change a single sample.
5. The original must not have changed while this ran.
6. Only then does the copy replace the original, keeping its permissions and owner.

Any failed check deletes the copy, leaves the original untouched, and records the reason on the move.

MusicBrainz ids are written only for albums identified against MusicBrainz. ReplayGain values come from Squirmy's own loudness measurements, relative to -18 LUFS.
