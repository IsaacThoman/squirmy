# Backup, restore and moving servers

This page says what to back up, what is safe to delete, and gives the commands to back up, restore, move to another machine and upgrade. The commands assume the `compose.yaml` from the repository, with its services `app` and `postgres`, run from the folder that holds it.

## What to back up

| What | Where | Why |
|---|---|---|
| **The database** | the `postgres` service (`squirmy_db` volume) | Accounts, likes, playlists, history, wantlists, identification and manual matches, organize history, settings. |
| **Your music** | your `MUSIC_DIR` | The audio itself. Squirmy never keeps a second copy. |
| **`secret.key`** | `/data/secret.key` in the `app` container (`squirmy_data` volume) | The key that encrypts app passwords, API keys, provider secrets and scrobbling connections, and signs stream URLs. Not needed if you set `SQUIRMY_SECRET` yourself; then keep that value safe instead. |
| **`assets/`** | `/data/assets/` | Original artwork: covers and images that were downloaded or taken out of your files. |

### What is in the data folder

| Path | Safe to delete? |
|---|---|
| `secret.key` | **No.** Without it, everything encrypted with it is unreadable: users have to make new app passwords and reconnect scrobbling, and an admin has to enter the API keys and provider secrets again. Sign-ins survive. |
| `assets/` | **No.** The database still lists the images as stored, so covers and artist images whose files are gone show as missing, and they are not downloaded or extracted again on their own. |
| `art/` | Yes. Resized copies of the artwork, rendered again on first request. |
| `transcodes/` | Yes. Converted streams, made again as people listen. The cache index is reconciled with the folder hourly and when the worker starts. |
| `staging/` | Only while no upload or inbox import is in progress. It holds files being imported; leftovers of finished imports are removed every 15 minutes. |

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

1. Clone the repository and copy your `.env` (with the **same** `POSTGRES_PASSWORD`) and any changes you made to `compose.yaml`.
2. Make the music available. Keep it mounted at the same path inside the container (`/music` in the standard `compose.yaml`); only `MUSIC_DIR`, the path on the host, may change.
3. Build the image and start only the database, which creates an empty one:

   ```sh
   docker compose build
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
2. Update and rebuild:

   ```sh
   git pull
   docker compose up -d --build
   ```

Migrations run on start, before the server serves anything, and only move forward. To go back to an older version, restore the dump you took before the upgrade into an empty database and run the older version.

`compose.yaml` pins PostgreSQL 17. To move to a newer major version of PostgreSQL, dump the database, change the image, remove the `squirmy_db` volume, and restore the dump as above.
