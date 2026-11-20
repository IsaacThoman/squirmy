# Adding music

There are three ways to get new music into Squirmy:

1. **Put it in a library folder.** Copy files into any library folder; a watched folder picks them up within seconds, others at the nightly scan or on **Scan now**. Nothing else on this page applies.
2. **Upload it** from the web app's **Add music** page, or through the API.
3. **Drop it in the inbox folder** on the server.

Uploads and the inbox are *imports*: Squirmy takes the files, identifies them, and files them into a managed library folder for you.

## Before you start: a managed folder to file into

Imports need a [managed folder](./organizing.md#make-a-folder-managed) to file music into. With exactly one enabled managed folder, that is the one. With several, choose one in **Admin → Server settings → Imports → Import into**. Otherwise uploads cannot start: **Add music** says what is missing, and the API answers `no_managed_root` or `import_root_not_set`.

## What an import does

```
receiving → extracting → moving → identifying → filing → completed
```

1. **Receiving.** Files arrive in the data folder's `staging/` area. Accepted are audio files, `cover.*` and `folder.*` images, `.lrc`, `.cue` and `.log` files, and `.zip` archives. Paths are checked: nothing absolute, no `..`, at most 8 folders deep.
2. **Extracting.** Zip archives are unpacked. An archive with an unsafe path, a symbolic link, encryption, more than 10,000 entries, or more data than the import may hold is refused whole. Zips inside zips are skipped.
3. **Moving.** The files move into `<managed folder>/_Incoming/<import id>/`.
4. **Identifying.** That folder is scanned. Once every file's audio has been hashed, duplicates are deleted and counted under `duplicatesSkipped`: a file is a **duplicate** when the library already has its audio, when an earlier import that is still processing has it, or when another file in the same import does. Retagged copies count as duplicates too, because the comparison is on the audio, not the tags. The rest is then identified like any other music. This step waits until every file is identified, or for an hour at most.
5. **Filing.** Albums identified with confidence are moved to their place under the [naming template](./organizing.md#the-naming-template). The `_Incoming/<import id>/` folder is removed once no audio is left in it.

### Where unidentified music stays

Albums that were not identified confidently stay in `<managed folder>/_Incoming/<import id>/`. They are in the library, browsable and playable, and the import's `reviewFolder` names the folder. Fix them in **Admin → Review queue** or with **Fix match**, then file them from **Admin → Organize**. Organize leaves `_Incoming` out of its plans unless the preview asks for it with `includeIncoming` (an API option of `POST /api/v1/admin/organize/preview`; the screen does not offer it yet).

### Limits

| Setting | Default | |
|---|---|---|
| `importMaxFileBytes` | 4 GiB | Largest single file, zip archives included. A larger file is refused with 413. |
| `importMaxBytes` | 64 GiB | Largest import, counting what its archives extract to. |

Change them in **Admin → Server settings → Imports**. A reverse proxy in front needs a matching body size limit; see [Reverse proxies](./reverse-proxy.md).

An import that receives no files for a day is failed and cleaned up.

## Uploading

Admins can always upload; members need **Can upload music** (see [Users and access](./users.md)).

### In the web app

**Add music** is in the sidebar and in the account menu for everyone who may upload.

1. Drop album folders, files or zip archives on the page, or use **Choose a folder** or **Choose files**. Folders keep their structure. The list shows every file before anything is sent, and files over the size limit are marked and left out.
2. Press **Upload**. Each file shows its progress, and the bar above shows all of it. **Pause** stops sending and **Resume** carries on where it stopped; **Cancel** throws away what was sent. Keep the tab open until the upload finishes; other pages of the app can be used meanwhile.
3. Once everything is sent, the page follows the import through its steps to the result: files received, duplicates skipped, albums filed (each linking to its page), and what was left for review, with a link to the review queue for admins. Files the server refused are listed with the reason.

Below, **Recent imports** lists your imports (an admin sees everyone's, inbox and provider imports included), updating as they move. Open one for its details, or cancel one that is still receiving.

### Through the API

With `curl` and `jq`:

```sh
SERVER=https://music.example.com

# Sign in.
TOKEN=$(curl -s -X POST $SERVER/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"you","password":"your password"}' | jq -r .token)

# 1. Create an import.
ID=$(curl -s -X POST $SERVER/api/v1/imports -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"OK Computer"}' | jq -r .id)

# 2. Send files. A relativePath field just before a file names its path in the import,
#    which keeps an album's files together. Repeat this request as often as you like.
curl -s -X POST $SERVER/api/v1/imports/$ID/files -H "Authorization: Bearer $TOKEN" \
  -F "relativePath=OK Computer/01 Airbag.flac" -F "file=@01 Airbag.flac" \
  -F "relativePath=OK Computer/02 Paranoid Android.flac" -F "file=@02 Paranoid Android.flac"

# A zip works too.
curl -s -X POST $SERVER/api/v1/imports/$ID/files -H "Authorization: Bearer $TOKEN" -F "file=@album.zip"

# 3. Start processing.
curl -s -X POST $SERVER/api/v1/imports/$ID/commit -H "Authorization: Bearer $TOKEN"

# 4. Follow it.
curl -s $SERVER/api/v1/imports/$ID -H "Authorization: Bearer $TOKEN" | jq '{status, step, counts, reviewFolder, error}'
```

The answer to each upload lists every file as `accepted` or `rejected` with a reason. `DELETE /api/v1/imports/$ID` cancels an import that is still receiving. `GET /api/v1/imports` lists your imports; an admin sees everyone's.

## The inbox folder

The inbox is a folder on the server that Squirmy empties into the library. Copy an album folder, a set of files or a zip into it, and it is imported.

1. Mount a folder for it. In Docker, add a volume to the `app` service and say where it is:

   ```yaml
   services:
     app:
       environment:
         SQUIRMY_INBOX_PATH: /inbox
       volumes:
         - /srv/inbox:/inbox
   ```

   Or set the `inboxPath` server setting instead, which takes precedence. The inbox may not be inside a library folder or the data folder, and the server needs write access to it.
2. Run `docker compose up -d`.
3. Copy music into it.

Each top-level item (a file or a folder) becomes one import once it has stopped changing for five seconds and every file in it is readable, so a copy still in progress is left alone. Hidden files and partial downloads (`.part` and similar) are never picked up. The inbox is polled every two seconds, which works on network mounts too.

What an import cannot take (unsupported files, or a whole import that failed) is moved to `Not imported/<import id>/` inside the inbox. Nothing is deleted except duplicates of music already in the library.
