# Reverse proxies and HTTPS

This page gets Squirmy onto an HTTPS address such as `https://music.example.com` behind Caddy, nginx or Traefik, with live updates, uploads and streaming working.

## What the proxy has to handle

Squirmy serves everything from one port (4747): the web app, the API under `/api`, the Subsonic API under `/rest`, and the realtime socket under `/socket.io`. Serve it at the root of its own host name; it does not support being mounted under a path such as `/squirmy`.

| Traffic | What it needs from the proxy |
|---|---|
| `/socket.io` | **WebSocket upgrades.** Playback state, device lists and live updates use one long-lived socket per open app. Without upgrades the web app shows "Reconnecting to the server…" and playback control between devices stops working. |
| `/api/v1/imports/…/files`, `/api/v1/acquisition/deliveries/…` | **Large request bodies.** Uploads are streamed, up to 4 GiB per file by default (`importMaxFileBytes`, which an admin can raise). The proxy must not cap or buffer them. |
| `/api/v1/stream/…`, `/rest/stream` | **Range requests** for seeking, passed through untouched, and **unbuffered responses**: a transcode is sent while ffmpeg encodes it, so buffering delays the start of playback. |
| Everything | `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, so the server knows the client and that the request was HTTPS. |

## 1. Configure Squirmy

Add these to the `app` service in `compose.yaml`, or `PUBLIC_URL=https://music.example.com` and `TRUST_PROXY=true` to `.env`:

```yaml
services:
  app:
    environment:
      PUBLIC_URL: https://music.example.com
      TRUST_PROXY: "true"
```

Then make port 4747 reachable only by the proxy. If the proxy runs on the same machine, bind the port to localhost:

```yaml
    ports:
      - "127.0.0.1:4747:4747"
```

If the proxy runs in the same Compose project, remove the `ports:` section from `app` and point the proxy at `app:4747`.

Apply with `docker compose up -d`.

## 2. Configure the proxy

### Coolify with Traefik

Import the repository using the Docker Compose build strategy and select `/compose.yaml`. Set `MUSIC_DIR` to the absolute path of your music folder on the Coolify server. Set `POSTGRES_PASSWORD`, `TRUST_PROXY=true`, and `PUBLIC_URL` to the browser-facing origin; `compose.yaml` passes all three to the app. Set `SQUIRMY_PORT=127.0.0.1:4747` to keep the host port on loopback.

Assign the domain to the `app` service and set its internal port to `4747`. Coolify creates the Traefik route. If an upstream proxy terminates TLS and connects to Traefik over HTTP, set the Coolify route to HTTP and keep `PUBLIC_URL` set to the public HTTPS origin.

### Caddy

Caddy gets a certificate on its own and passes WebSockets, Range requests and large bodies through by default.

```text
music.example.com {
	reverse_proxy 127.0.0.1:4747 {
		# Send transcoded audio as it is encoded.
		flush_interval -1
	}
}
```

Use `app:4747` instead of `127.0.0.1:4747` when Caddy runs in the same Compose project.

### nginx

nginx needs WebSocket upgrades, no body size limit and no buffering spelled out:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name music.example.com;

    ssl_certificate     /etc/letsencrypt/live/music.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/music.example.com/privkey.pem;

    # Uploads: no size limit here; Squirmy enforces its own.
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:4747;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # /socket.io
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Stream uploads to Squirmy and audio to the client as it arrives.
        proxy_request_buffering off;
        proxy_buffering off;

        # Long uploads and long-lived sockets.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}

server {
    listen 80;
    server_name music.example.com;
    return 301 https://$host$request_uri;
}
```

Run `nginx -t` before reloading. With nginx's default `client_max_body_size` of 1 MB, uploads fail with 413.

### Traefik

With Traefik in the same Compose project and the Docker provider, put labels on the `app` service and remove its `ports:`:

```yaml
services:
  app:
    labels:
      - traefik.enable=true
      - traefik.http.routers.squirmy.rule=Host(`music.example.com`)
      - traefik.http.routers.squirmy.entrypoints=websecure
      - traefik.http.routers.squirmy.tls.certresolver=letsencrypt
      - traefik.http.services.squirmy.loadbalancer.server.port=4747
```

Traefik passes WebSockets, Range requests and streamed responses through by default. Traefik v3 does limit how long it reads a request to 60 seconds, which cuts off large uploads on a slow link; lift it on the entry point in Traefik's own configuration:

```yaml
command:
  - --entrypoints.websecure.address=:443
  - --entrypoints.websecure.transport.respondingTimeouts.readTimeout=0
```

Do not add Traefik's buffering middleware to this router.

### Checking it

From another machine:

```sh
curl https://music.example.com/ready
```

Then open the web app, start a song, and check that the browser's developer tools show a WebSocket connection to `/socket.io` with status 101. The Caddy and Traefik setups above were tested against a running server for Range requests, a live transcode and a WebSocket connection; the nginx one has not been run.

## What `TRUST_PROXY` does

With `TRUST_PROXY=true` the server believes the `X-Forwarded-*` headers. That changes three things:

- **The client address** comes from `X-Forwarded-For`. Login is limited to 20 attempts a minute per address and 5 per username, and failed Subsonic logins are limited per address. Behind a proxy without `TRUST_PROXY`, every request seems to come from the proxy, so one person's typos can lock everyone out for a minute.
- **The protocol** comes from `X-Forwarded-Proto`. The session cookie is marked `Secure` only when the request was HTTPS, and links the server builds itself (when `PUBLIC_URL` is not set) use the right scheme.
- **The host** comes from `X-Forwarded-Host`.

Leave it `false` when nothing sits in front of Squirmy. With it on and port 4747 reachable directly, anyone can claim any address in `X-Forwarded-For` and get around the login limits.

## HTTPS and the apps

- **Web app.** Works over HTTP or HTTPS. Over plain HTTP your password and session cookie cross the network unencrypted.
- **iOS app.** When you type an address without a scheme (`music.example.com`), it tries `https://` first and falls back to `http://`. Plain HTTP works: on a local address (a `.local` or `.lan` name, a private IP range, or a Tailscale address) it connects without comment, and on a public address it warns "This server doesn't use HTTPS, so your password is sent unencrypted." The first connection to a server on your local network makes iOS ask for Local Network access; allow it.
- **Subsonic apps.** Many send your app password, or a hash of it, in the URL of every request. Use HTTPS for any server reachable from the internet.
