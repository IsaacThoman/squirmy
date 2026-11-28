# Integrations

Open **Admin → Integrations** in the web app to manage server webhooks, inspect their delivery log and configure MQTT. Each user can create personal webhooks in **Settings → Webhooks**.

## Webhooks

Give a subscription a name, an HTTP or HTTPS destination and the events it should receive. Save the signing secret when it is shown. **Send test** queues a `test` event. The admin delivery log shows the latest 100 deliveries from both kinds of subscription, kept for up to 30 days.

An admin webhook receives events from across the server. A personal webhook receives its user's playback, scrobbles and imports, plus scan and album events for the shared library.

| Event | Data |
| --- | --- |
| `playback.started`, `playback.paused`, `playback.stopped`, `playback.track_changed` | Device ID, track ID, album ID, position in milliseconds and state |
| `scrobble` | Completed play ID, track ID, album ID, start time and milliseconds played |
| `library.scan_finished` | Library root ID and counts from a full discovery scan. Probing and matching continue in background jobs. |
| `library.album_added` | Album ID, title and artist when file ingest adds the first copy to the shared collection |
| `import.finished` | Import ID, outcome and kind |

The receiver gets an HTTP POST with `Content-Type: application/json` and an envelope with `id`, `type`, `at` (ISO 8601), `userId` (null for shared events) and `data`. Compare `X-Squirmy-Signature` to `sha256=` followed by the hex HMAC-SHA256 of the **raw request body**, using the signing secret as the HMAC key. Use constant-time comparison. Squirmy retries timeouts, transient HTTP errors and connection failures with backoff. Return 2xx to acknowledge receipt and use the signed event ID to deduplicate a retry.

HTTP destinations must resolve to public addresses by default. Enable **Allow local HTTP destinations** to also allow RFC1918 IPv4 targets. That permits users' configured URLs to reach services on those networks. Loopback and link-local addresses remain blocked. Redirects are never followed.

## MQTT and Home Assistant

Enable MQTT under **Connection settings** and enter a broker URL, optional credentials and a topic prefix unique to this Squirmy installation. Use `mqtts://` for TLS. Squirmy connects only when MQTT is configured. Set [`PUBLIC_URL`](./configuration.md#environment-variables) to supply absolute cover art URLs.

Squirmy publishes retained JSON under `<prefix>/<user ID>/<base64url device ID>/state` when a device is the active player. It includes the track title, artist, album, cover art, position in milliseconds, volume from 0 to 1 and playback state. It also publishes retained MQTT discovery for a Home Assistant sensor with the playback state and the other fields as attributes.

To control that device, publish non-retained JSON to the same topic with `/command` in place of `/state`. Use `{"type":"play"}`, `{"type":"pause"}`, `{"type":"next"}`, `{"type":"previous"}` or `{"type":"volume","value":0.4}`. Restrict broker permissions for these topics to trusted automations. Anyone who can publish commands there can control the corresponding Squirmy device.

## Scoped API tokens

Open **Settings → App passwords → Create**, turn on **Scoped API token**, choose permissions and optionally set an expiry date. Enter your account password to create it and copy the token when it appears. Use it as `Authorization: Bearer <token>` on supported `/api/v1` routes.

| Scope | Access |
| --- | --- |
| `library:read` | Read the library, catalog, search results, likes, history and playlists |
| `playback:control` | Read session and device state, request playback descriptors and send commands to `POST /api/v1/me/session/command` |
| `playlists:manage` | Read and manage playlists and their entries |
| `admin` | Use admin API routes while the account has the admin role |

The playback endpoint accepts the same JSON commands as MQTT and targets the user's active device in the shared session. Revoke a token from the list to end its access. Existing Subsonic credentials keep their original access via the [Subsonic API](./subsonic.md).
