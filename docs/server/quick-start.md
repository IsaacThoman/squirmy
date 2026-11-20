# Quick start

By the end of this page you will have Squirmy and its database running in Docker, your music scanning, and an admin account to sign in with.

## What you need

- A Linux, macOS or Windows machine with **Docker Engine and Docker Compose v2** (`docker compose version` prints a version). The image builds for amd64 and arm64.
- **Git**, to fetch the source. No release of the image has been published yet, so Compose builds it from the repository on your machine. The first build takes a few minutes.
- Your music in a folder the machine can read. Squirmy reads MP3, FLAC, M4A/MP4/AAC, Ogg Vorbis, Opus, WAV, AIFF, WavPack, APE, WMA and DSF files.
- Disk space for the database and the data folder (artwork, transcodes and uploads in progress). Plan on a few GB plus the transcode cache, which is capped at 10 GB by default.

The image contains the API, the background worker, the web app, `ffmpeg` and `fpcalc`. `compose.yaml` adds PostgreSQL 17.

## 1. Get the files

```sh
git clone https://github.com/IsaacThoman/squirmy.git
cd squirmy
```

`compose.yaml` in this folder runs two services: `app` (Squirmy) and `postgres` (its database), with two named volumes, `squirmy_db` for the database and `squirmy_data` for the data folder.

## 2. Say where your music is

Create a file named `.env` next to `compose.yaml`. Compose reads it on every command, so you do not have to repeat the values.

```sh
# The folder with your music. It is mounted in the container at /music.
MUSIC_DIR=/srv/music
# The database password. Set it before the first start: changing it later does not
# change the password of a database that already exists.
POSTGRES_PASSWORD=change-me
# Optional: the port on the host (default 4747).
# SQUIRMY_PORT=4747
```

The container runs as the user `node` (uid 1000, gid 1000). It needs read access to the music folder. Squirmy changes nothing in a folder unless you make it [managed](./organizing.md), and a managed folder (or one that receives uploads) also needs write access for that user.

To guarantee the server can never write to your music, make the mount read-only in `compose.yaml`:

```yaml
    volumes:
      - ${MUSIC_DIR:-./music}:/music:ro
```

## 3. Start it

```sh
docker compose up -d --build
```

The first start builds the image, creates the database, runs the migrations, adds `/music` as a read-only library folder and starts scanning it. Check that it is up:

```sh
docker compose ps
curl http://localhost:4747/ready
```

`/ready` answers `{"status":"ready"}` once the server can reach its database. If it does not, see [Troubleshooting](./troubleshooting.md).

## 4. Create the admin account

1. Open `http://localhost:4747` (or the machine's address and your `SQUIRMY_PORT`).
2. **Welcome to Squirmy**: choose a username and a password of at least 8 characters, then **Continue**. The first account is the admin.
3. **Where is your music?**: choose **Skip for now**. Your music folder was already added from `compose.yaml`, and adding `/music` a second time fails with "That folder is already a library root". Add other folders later in **Admin → Library**.
4. **You're all set**: choose **Start listening**.

Everyone else joins by invite. See [Users and access](./users.md).

## What happens during the first scan

Open **Admin → Library** to watch it. Each folder shows what it is doing ("Finding files", "Reading tags", "Identifying albums"), and the top of the page counts songs, playing time and how much of the library is identified.

1. **Finding files.** The folder is walked and every audio file is recorded. This is quick.
2. **Reading tags.** Tags and technical details are read and the files are grouped into albums. As soon as an album's tags are read it is browsable and playable, built from its tags.
3. **Identifying albums.** Each album is matched against MusicBrainz, by the MusicBrainz ids in its tags when they are there, otherwise by searching for its artist and title and comparing track counts, titles and lengths. Confident matches are applied; uncertain ones wait in the [review queue](./library.md#the-review-queue-and-fix-match).
4. **Filling in.** Covers, artist images, biographies, lyrics and external ids are fetched for identified albums.
5. **Measuring.** A hash of each file's audio (so moved, retagged and duplicate files are recognized) and its loudness (for [volume normalization](./playback.md#loudness-normalization)) are computed at low priority, so they never hold up browsing.

### How long it takes, and why

Reading tags runs at disk speed. Identification is limited by MusicBrainz: its public server allows one request per second from each client, and Squirmy keeps to that. An album needs several requests (a search, a few candidate releases, then its release group and artist for the details).

On the demo library that ships with the repository, 12 albums took about two and a half minutes and 80 MusicBrainz requests. That is roughly 10 to 15 seconds per album, so plan on:

| Library | Identification |
|---|---|
| 100 albums | about 20 to 30 minutes |
| 1,000 albums | a few hours |
| 10,000 albums | more than a day |

Everything stays playable from its tags while this runs, and the work resumes where it stopped after a restart. If you run your own MusicBrainz mirror, point Squirmy at it in **Admin → Server settings → MusicBrainz server** and the limit goes away. [Metadata and privacy](./metadata-and-privacy.md#the-musicbrainz-rate-limit) has the details.

## Updating

```sh
cd squirmy
git pull
docker compose up -d --build
```

The new container runs any database migrations on start, before it serves anything. Your database and data volumes are kept. Read [Backup, restore and moving](./backup.md) before upgrading a server you care about, and take a database dump first.

## Uninstalling

Stop and remove the containers, keeping the database and data volumes:

```sh
docker compose down
```

Remove the volumes too. This deletes the database (accounts, likes, playlists, history, identification) and the data folder (artwork, transcodes, the server secret):

```sh
docker compose down -v
```

Your music folder is never deleted. Files in a managed folder stay where the last organize batch put them.

## Next steps

- Put Squirmy behind HTTPS: [Reverse proxies and HTTPS](./reverse-proxy.md).
- See every option: [Configuration](./configuration.md).
- Connect your phone: [The iOS app](../use/ios.md), or a [Subsonic client](./subsonic.md).
