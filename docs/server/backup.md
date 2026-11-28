# Backup, restore and moving servers

This page says what to back up, what is safe to delete, and gives the commands to back up, restore, move to another machine and upgrade. The commands assume the `compose.yaml` from the repository, with its services `app` and `postgres`, run from the folder that holds it.

## What to back up

| What | Where | Why |
|---|---|---|
| **The database** | the `postgres` service (`squirmy_db` volume) | Accounts, likes, playlists, history, wantlists, identification and manual matches, organize history, settings. |
| **Your music** | your `MUSIC_DIR` | The audio itself. Squirmy never keeps a second copy. |
| **`secret.key`** | `/data/secret.key` in the `app` container (`squirmy_data` volume) | The key that encrypts app passwords, API keys, provider secrets and scrobbling connections, and signs stream URLs. Not needed if you set `SQUIRMY_SECRET` yourself; then keep that value safe instead. |
| **`assets/`** | `/data/assets/` | Original artwork: covers and images that were downloaded or taken out of your files. Most of it can be rebuilt (see below), but backing it up saves the downloads and covers images whose source has changed. |

### What is in the data folder

| Path | Safe to delete? |
|---|---|
| `secret.key` | **No.** Without it, everything encrypted with it is unreadable: users have to make new app passwords and reconnect scrobbling, and an admin has to enter the API keys and provider secrets again. Sign-ins survive. |
| `assets/` | **Better not**, but it is mostly rebuilt. See [When `assets/` is lost](#when-assets-is-lost). |
| `art/` | Yes. Resized copies of the artwork, rendered again on first request. |
| `transcodes/` | Yes. Converted streams, made again as people listen. The cache index is reconciled with the folder hourly and when the worker starts. |
| `previews/` | Yes. 30-second previews for [share links](./sharing.md), made again when played. Previews not played for a week are deleted daily. |
| `staging/` | Only while no upload or inbox import is in progress. It holds files being imported; leftovers of finished imports are removed every 15 minutes. |

### When `assets/` is lost

If image files under `assets/` are deleted, or the data folder is restored from a backup older than the database, Squirmy rebuilds each image from where it came from. It does this when the image is first asked for, and a daily check at 04:40 UTC finds the rest.

| Image | Rebuilt from | Rebuilt when |
|---|---|---|
| A picture embedded in a music file | The music file, read again while the request waits | A file in the library still has exactly that picture |
| A cover or artist image from the album's folder (`cover.jpg`, `folder.jpg`…) | The image file, read again while the request waits | The image is still at the same path and unchanged |
| A cover downloaded while identifying an album (Cover Art Archive, Deezer) | The same URL, downloaded again in the background | The URL still serves exactly the same image |
| A cover or image shown for music you browse (search results, artist pages, discographies) | The same URL, downloaded again in the background | The URL still serves an image; it may be a newer version |

While an image is being downloaded again it answers "not found" and is not cached, so it appears on a later visit.

What cannot be rebuilt: a picture the music files no longer contain (the file was retagged, or removed from the library), a folder image that was edited, deleted or moved (organizing an album moves its folder image, so the stored path no longer exists), and a downloaded cover the URL no longer serves or serves differently. Squirmy marks such an image as missing and stops trying; the daily check tries it once a week again, and makes it ready as soon as its file is back, for example after you restore `assets/` from a backup. An identified album whose cover is missing gets a new one from Cover Art Archive or Deezer the next time it is enriched (for example after switching one of them off and on again).

Everything else in the database can be rebuilt from the music by scanning, except user data and manual decisions, which is why the database dump matters.

## Back up

1. Dump the database (it can stay running):

   ```sh
   docker compose exec -T postgres pg_dump -U squirmy -d squirmy -Fc > squirmy-$(date +%F).dump
   ```

2. Save the secret and the original artwork:

   ```sh
   docker compose exec -T app tar czf - -C /data secret.key assets > squirmy-data-$(date +%F).tgz
   ```

3. Back up your music folder as you already do.

Run steps 1 and 2 from cron for regular backups. For scale, the dump of the 12-album demo library is 2.5 MB.

## Restore, or move to another machine

On the new machine:

1. Download `compose.yaml` as in the [quick start](./quick-start.md#_1-get-the-compose-file) (or clone the repository if you [build from the source](./quick-start.md#building-from-the-source)), and copy your `.env` (with the **same** `POSTGRES_PASSWORD`) and any changes you made to `compose.yaml`. Use the release the dump came from, or a newer one.
2. Make the music available. Keep it mounted at the same path inside the container (`/music` in the standard `compose.yaml`); only `MUSIC_DIR`, the path on the host, may change.
3. Pull the image and start only the database, which creates an empty one (run `docker compose build` instead of `pull` when you build from the source):

   ```sh
   docker compose pull
   docker compose up -d postgres
   ```

4. Restore the dump into it:

   ```sh
   docker compose exec -T postgres pg_restore -U squirmy -d squirmy --no-owner < squirmy-2026-11-20.dump
   ```

5. Restore the secret and artwork into the data volume, without starting the server (which would otherwise generate a new secret):

   ```sh
   docker compose run --rm -T --no-deps --entrypoint tar app xzf - -C /data < squirmy-data-2026-11-20.tgz
   ```

6. Start everything:

   ```sh
   docker compose up -d
   ```

The server runs any migrations the dump needs, then scans the library folders. Files at the same paths are recognized, so nothing is identified twice.

Restore into an empty database only: do not start `app` against the new database before step 4, because its migrations would create the tables the dump is about to create.

### When a folder's path inside the container changes

There is no setting to change a library folder's path. If you must move one (for example from `/srv/music` without Docker to `/music` in Docker), stop the app, change the stored path, start it again and scan:

```sh
docker compose stop app
docker compose exec postgres psql -U squirmy -d squirmy \
  -c "update library_roots set path = '/music' where path = '/srv/music'"
docker compose up -d app
```

Then choose **Scan now** on that folder in **Admin → Library**. The relative paths inside the folder must be unchanged. This was tested on a scratch server: every file was found again and none was marked missing. Removing the folder and adding it again at the new path also brings the music back, but it is read and identified again from scratch, which on a large library takes hours.

## Upgrading

1. Take a database dump (above).
2. Pull the new image and restart:

   ```sh
   docker compose pull
   docker compose up -d
   ```

   If you [build the image from the source](./quick-start.md#building-from-the-source), run `git pull` and `docker compose up -d --build` instead.

Migrations run on start, before the server serves anything, and only move forward. To go back to an older version, restore the dump you took before the upgrade into an empty database and run the older version.

`compose.yaml` pins PostgreSQL 17. To move to a newer major version of PostgreSQL, dump the database, change the image, remove the `squirmy_db` volume, and restore the dump as above.
