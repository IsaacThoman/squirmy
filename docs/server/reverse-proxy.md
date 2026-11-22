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

Squirmy compresses its own responses (brotli or gzip for the API's JSON, Subsonic's XML and the web app's files; never audio, images or ranged responses), so the proxy does not need to. API reads carry an `ETag` and `Cache-Control: private, no-cache`: keep both, and pass `If-None-Match` through, so an unchanged page is a short 304. Never cache them in a shared cache.

Artwork (`/api/v1/art/…`) is `public, max-age=31536000, immutable`: the bytes for a URL never change, so a CDN may keep it as long as it likes. The web app asks for `/api/v1/art/<id>/<size>.webp`, which Cloudflare caches by default because of the extension; for the extensionless form the iOS app uses, add a Cloudflare Cache Rule that makes `/api/v1/art/` eligible for cache.

## 1. Configure Squirmy

Add these to `.env` next to `compose.yaml` (or to the `app` service's `environment:`):

```sh
PUBLIC_URL=https://music.example.com
TRUST_PROXY=true
```

`TRUST_PROXY=true` is right for one proxy (Caddy, nginx, Traefik) on the same machine or a private network. With a Cloudflare Tunnel in front of that proxy, also set `CLIENT_IP_HEADER`; see [Cloudflare Tunnel](#cloudflare-tunnel). For other layouts, see [What `TRUST_PROXY` does](#what-trust-proxy-does).

Then make port 4747 reachable only by the proxy. This matters for `TRUST_PROXY=true` too: Docker often hands a published port's connections to the container from its own bridge address (always on Docker Desktop and with rootless Docker or Podman, and for IPv6 clients on Linux), so a client on the internet would look like a proxy on a private network and could choose its address. If the proxy runs on the same machine, bind the port to localhost (`SQUIRMY_PORT=127.0.0.1:4747` in `.env` does the same):

```yaml
    ports:
      - "127.0.0.1:4747:4747"
```

If the proxy runs in the same Compose project, remove the `ports:` section from `app` and point the proxy at `app:4747`.

Apply with `docker compose up -d`.

## 2. Configure the proxy

### Coolify with Traefik

Import the repository using the Docker Compose build strategy and select `/compose.yaml`. Set `MUSIC_DIR` to the absolute path of your music folder on the Coolify server. Set `POSTGRES_PASSWORD`, `TRUST_PROXY=true`, and `PUBLIC_URL` to the browser-facing origin (add `CLIENT_IP_HEADER=CF-Connecting-IP` when a Cloudflare Tunnel connects to Coolify's proxy, but only if Traefik's public ports 80 and 443 do not answer for this host name: otherwise anyone can send a request to the server's own address with any `CF-Connecting-IP`; see [Cloudflare Tunnel](#cloudflare-tunnel)). `compose.yaml` passes these to the app. Set `SQUIRMY_PORT=127.0.0.1:4747` to keep the host port on loopback.

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

### Cloudflare Tunnel

With a tunnel, requests travel browser → Cloudflare → `cloudflared` → your proxy (Traefik, Caddy, nginx) → Squirmy. Cloudflare puts the visitor's address in `CF-Connecting-IP` and overwrites whatever the visitor sent there; the proxies in between pass it on unchanged. Set:

```sh
PUBLIC_URL=https://music.example.com
TRUST_PROXY=true
CLIENT_IP_HEADER=CF-Connecting-IP
```

`TRUST_PROXY=true` makes Squirmy believe the proxy next to it (on the same machine or a private network), and `CLIENT_IP_HEADER` reads the visitor's address from the header Cloudflare set. Without `CLIENT_IP_HEADER`, every visitor appears as `cloudflared`, because Traefik and Caddy replace `X-Forwarded-For` from a peer they do not trust, and the per-address sign-in limits would then be shared by everyone.

`CF-Connecting-IP` can only be trusted if nobody can reach your proxy for this host name without going through Cloudflare. A tunnel needs no open ports: if the proxy also listens on the internet for this host name, firewall it to Cloudflare's addresses, or remove the header there for other traffic, or use the hop count below instead.

When `cloudflared` connects straight to Squirmy (no proxy in between), the same three settings work.

**Without `CLIENT_IP_HEADER`.** If your proxy is set to trust `cloudflared`'s forwarded headers (Caddy `trusted_proxies`, Traefik `forwardedHeaders.trustedIPs`), it appends to Cloudflare's `X-Forwarded-For` instead of replacing it, and `TRUST_PROXY=2` (your proxy and `cloudflared`) gives the visitor's address.

Cloudflare's own `X-Forwarded-Proto` usually does not survive the proxy, which sees plain HTTP from `cloudflared`. That is why `PUBLIC_URL` matters here: an `https://` `PUBLIC_URL` marks the session cookie `Secure` for requests to that host name.

### Checking it

From another machine:

```sh
curl https://music.example.com/ready
```

Then open the web app, start a song, and check that the browser's developer tools show a WebSocket connection to `/socket.io` with status 101. The Caddy and Traefik setups above were tested against a running server for Range requests, a live transcode and a WebSocket connection; the nginx one has not been run.

## What `TRUST_PROXY` does

`TRUST_PROXY` says which peers may tell Squirmy who the client is, through `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`. The first address in `X-Forwarded-For` is whatever the client wrote; nginx and Cloudflare append to it rather than replace it. So Squirmy reads the header from the right: it skips the proxies it trusts and takes the first address after them.

| Value | Trusts | Use it for |
|---|---|---|
| `false` (default) | nobody | nothing in front of Squirmy |
| `true` | one proxy, and only when it connects from this machine or a private network (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, link-local, `::1`, `fc00::/7`) | Caddy, nginx or Traefik on the same machine, in the same Compose project, or on your LAN or tailnet |
| a number, such as `2` | that many proxies, from any address | a chain of proxies (Cloudflare Tunnel into Caddy that trusts `cloudflared`: `2`), when port 4747 is reachable only through them |
| addresses, such as `127.0.0.1,172.16.0.0/12` | any proxy in the list, CIDR ranges and `loopback`, `linklocal`, `uniquelocal`, `private` allowed | proxies with known addresses, including one on a public address |

It changes three things:

- **The client address.** Sign-in is limited per address and per username, register and setup per address, and Subsonic failures are counted per address (see [Users](./users.md#signing-in-and-sessions)). IPv6 addresses count per /64, since one client can usually pick any address in its /64. Without `TRUST_PROXY` behind a proxy, every request seems to come from the proxy, and everyone shares one address's limits.
- **The protocol** comes from `X-Forwarded-Proto`. The session cookie is marked `Secure` when the request was HTTPS, or when `PUBLIC_URL` is `https://` and the request is for its host name. Links the server builds itself (when `PUBLIC_URL` is not set) use the right scheme.
- **The host** comes from `X-Forwarded-Host`.

`CLIENT_IP_HEADER` names a header the outermost proxy sets to the client's address, such as `CF-Connecting-IP` behind Cloudflare. It is read only from a peer `TRUST_PROXY` trusts, and only when it holds a single address; otherwise the `X-Forwarded-For` rule above applies.

Anyone who can reach port 4747 directly can write any `X-Forwarded-*` headers. `true` ignores them from internet addresses that reach Squirmy as themselves, but Docker's published ports often present outside clients as the bridge address (see [step 1](#_1-configure-squirmy)), and a number trusts any peer. So keep the port bound to localhost or the Compose network whenever `TRUST_PROXY` is set. Docker's published ports also bypass host firewalls such as ufw. If the proxy reaches Squirmy from a global IPv6 address (a Docker IPv6 network on a public prefix), `true` does not trust it: list its address or prefix instead.

`CLIENT_IP_HEADER` needs `TRUST_PROXY`; the server refuses to start with one and not the other.

## HTTPS and the apps

- **Web app.** Works over HTTP or HTTPS. Over plain HTTP your password and session cookie cross the network unencrypted.
- **iOS app.** When you type an address without a scheme (`music.example.com`), it tries `https://` first and falls back to `http://`. Plain HTTP works: on a local address (a `.local` or `.lan` name, a private IP range, or a Tailscale address) it connects without comment, and on a public address it warns "This server doesn't use HTTPS, so your password is sent unencrypted." The first connection to a server on your local network makes iOS ask for Local Network access; allow it.
- **Subsonic apps.** Many send your app password, or a hash of it, in the URL of every request. Use HTTPS for any server reachable from the internet.
