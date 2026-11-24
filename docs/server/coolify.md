# Deploying on Coolify

[Coolify](https://coolify.io) can deploy Squirmy straight from the repository's `compose.yaml` as a Docker Compose resource, database included. That works, but on Coolify, run the database as a separate resource and deploy only the app against it. This page says why, how to set it up, and how to move an existing install over.

## Why the database should be separate

Coolify deploys a Docker Compose resource by running `docker compose up` on the whole stack, and Compose recreates every service whose generated configuration changed. Coolify regenerates that configuration on each deploy, so in practice **every deploy of the app also stops and recreates Postgres**: on our test server it happens on every push. That costs you:

- **Downtime on every deploy.** While Postgres stops and starts again, every request, playback session and background job fails, and the new app waits for the database to be healthy before it starts. Compose resources also get no [rolling update](https://coolify.io/docs/applications/deployments/rolling-updates), so the app is down too.
- **A crash-recovery risk on every deploy.** Postgres needs time to shut down cleanly: it writes a checkpoint first. When it takes longer than the container's stop timeout (10 seconds unless the service sets `stop_grace_period`), Docker kills it, and it starts with crash recovery. Recovery keeps committed data, but empties unlogged tables, so a [search index import](../local-search-index.md#restarts) under way then starts again from the beginning.

A database resource of its own is not touched when you deploy the app: it stops only when you stop it. The app, deployed on its own, can then use rolling updates.

## Set it up

1. In the same Coolify project and environment as the app, add a database: **+ New → Database → PostgreSQL**. Use PostgreSQL 15 or newer (17 is what `compose.yaml` uses); the official image includes the `pg_trgm` extension Squirmy's migrations create. Set the user, password and database name (for example `squirmy` for all but the password), and start it.
2. Deploy the app as an **Application** from the image (`ghcr.io/isaacthoman/squirmy:latest`) or the repository's `Dockerfile`, rather than from `compose.yaml`. Give it the volumes and environment variables the `app` service in [`compose.yaml`](https://github.com/IsaacThoman/squirmy/blob/dev/compose.yaml) has, with **`DATABASE_URL`** set to the database's **Postgres URL (internal)**, shown on its page in Coolify. An application reaches the database over Coolify's network. Set **Ports Exposes** to `4747` and leave **Ports Mappings** empty, since Coolify's proxy routes to the container: two containers cannot publish the same host port, so a mapping rules out rolling updates. If you keep a Docker Compose resource for the app, delete its `postgres` service and the `depends_on` that points at it, and turn on **Connect to Predefined Network** so the app can reach the database.
3. Leave the app's stop grace period at 30 seconds or more (**Advanced → Operations**, 30 by default), so long jobs can record where they got to when a deploy stops the app.

## Move an existing install

Moving takes the app down for a few minutes. Do it at a quiet time: anything written after the dump (a play, a like, a scan) is not carried over.

1. **Dump** the current database. On the Coolify server, find the stack's Postgres container with `docker ps` (its name starts with `postgres-`) and dump it:

   ```sh
   docker exec <postgres container> pg_dump -U squirmy -d squirmy -Fc > squirmy-$(date +%F).dump
   ```

2. **Create the database resource** as in [Set it up](#set-it-up), step 1, and start it. Leave it empty: do not point the app at it yet, because its migrations would create the tables the dump is about to create.
3. **Restore** the dump into it. Find its container with `docker ps` (Coolify names it after the resource's id) and restore with the user and database name you chose:

   ```sh
   docker exec -i <new database container> pg_restore -U squirmy -d squirmy --no-owner < squirmy-2026-11-23.dump
   ```

4. **Switch `DATABASE_URL`** in the app's environment variables to the new database's internal URL, and remove the old `postgres` service (step 2 of [Set it up](#set-it-up)). Keep the app's `/data` volume: it holds `secret.key` and the artwork.
5. **Redeploy** the app. It runs any migrations the dump needs and comes back with your library, users and settings. Check that `https://<your address>/ready` answers and that **Admin → Library** shows your albums.

Keep the old database volume until you are satisfied, then delete it in Coolify. [Backup, restore and moving](./backup.md) covers backups of the new setup: run its `pg_dump` against the database container directly.
