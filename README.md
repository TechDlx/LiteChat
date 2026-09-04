# LiteChat

Temporary, disposable chat rooms. Create a room, get a 4-character code, share it.
No accounts, no email, no tracking. A room disappears once it has been idle for 30 days.

- **4-character codes** from a 32-symbol alphabet with no ambiguous characters (no `I`, `O`, `0`, `1`) — about 1,048,576 combinations.
- **Random names** — everyone is assigned something like `SwiftOtter` on join. A refresh keeps your name for the session.
- **30-day idle expiry** — every message or join resets the clock. An hourly sweep deletes rooms past the window.
- **Image attachments** - paste, drag or pick. Re-encoded to a WebP preview, EXIF stripped, served from a separate origin.
- **Two dependencies** (`ws`, `sharp`), no build step, no database server.

## Run it locally

```bash
npm install
npm start
```

Open <http://localhost:3000>. Open a second browser window (or an incognito one) to talk to yourself.

To keep rooms across restarts, run the persistent variant — it defaults `DATA_DIR` to `./data`
and works the same in PowerShell, cmd and bash:

```bash
npm run start:persist
```

Or set `DATA_DIR` yourself to any writable folder. The syntax differs per shell:

```bash
DATA_DIR=/var/lib/litechat npm start          # bash / zsh
```

```powershell
$env:DATA_DIR = "./data"; npm start           # PowerShell
```

Without `DATA_DIR` the app runs entirely in memory and rooms reset when the process stops.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | *(unset)* | Folder for `rooms.json`. Unset means memory-only. |
| `UPLOADS_DIR` | `$DATA_DIR/uploads` | Where images are written. Uploads are off when neither is set. |
| `UPLOADS` | *(unset)* | Set to `off` to disable image uploads entirely. |
| `IMAGE_BASE_URL` | *(unset)* | Public origin serving images, e.g. `https://i.example.com`. Unset means the app serves them itself at `/i`, which is fine locally but shares an origin with the app. |

## Run it with Docker

```bash
docker compose up --build
```

That mounts a named volume at `/data` and sets `DATA_DIR`, so rooms survive `docker compose restart`.

## Host it for free

Chat needs a long-lived connection, so static/serverless hosts (Vercel, Netlify, GitHub Pages)
will not work for the server. You need somewhere that runs a container or a Node process continuously.

### Easiest: Render free web service

1. Push this folder to a GitHub repo.
2. On Render, **New → Web Service**, pick the repo. It detects the `Dockerfile`.
3. Instance type **Free**. No environment variables needed.
4. Deploy. You get an HTTPS URL with WebSockets working.

Caveat: free instances sleep after ~15 minutes of inactivity and have no persistent disk, so
**rooms reset whenever the instance wakes up**. Fine for testing and casual use; the 30-day
expiry effectively becomes "until the server restarts." Koyeb's free tier behaves similarly.

### Free *and* actually persistent: Oracle Cloud Always Free VM

An always-on VM with a real disk, so the 30-day lifetime means what it says. The stack is
the app plus [Caddy](https://caddyserver.com/) for automatic HTTPS:

```bash
cp .env.example .env && nano .env          # set DOMAIN and ACME_EMAIL
docker compose -f docker-compose.prod.yml up -d --build
```

**Full walkthrough: [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)** — creating the VM, the two
firewalls Oracle makes you open, DNS, certificates, updates and backups.

### Fly.io

Works well technically and offers volumes for persistence. Check their current pricing page
before committing — the free allowance has changed over time.

### Moving between hosts

Storage sits behind one small module ([lib/store.js](lib/store.js)) driven by `DATA_DIR`.
The same image runs on all of the above. To carry rooms across a move, copy `rooms.json`.

## How it works

```
Browser (static HTML/CSS/JS)  ──HTTP──►  Node server ──► rooms in memory
        └───────WebSocket────────────►               └──► rooms.json snapshot
```

| File | Role |
| --- | --- |
| [server.js](server.js) | HTTP routes, static file serving, WebSocket handling, shutdown flush |
| [lib/rooms.js](lib/rooms.js) | Room registry, code generation, membership, expiry sweep |
| [lib/store.js](lib/store.js) | Debounced atomic JSON snapshot |
| [lib/names.js](lib/names.js) | Random name and colour assignment |
| [lib/uploads.js](lib/uploads.js) | Image validation, quotas, storage and orphan reclamation |
| [lib/encode.js](lib/encode.js) | The sharp pipeline, isolated so a missing binary only disables uploads |
| [test/run.mjs](test/run.mjs) | End-to-end suite - `npm test` |
| [public/](public/) | The entire frontend — three files, no build |
| [docker-compose.prod.yml](docker-compose.prod.yml) + [Caddyfile](Caddyfile) | Production stack with automatic HTTPS |
| [render.yaml](render.yaml) | Render blueprint for the one-click path |

### Limits

| Thing | Cap |
| --- | --- |
| Message length | 2,000 characters |
| Messages retained per room | 500 (oldest dropped) |
| Concurrent members per room | 100 |
| Send rate | 20 messages per 10 seconds, per connection |
| Room lifetime | 30 days after the last activity |
| Image upload | 3 MB, JPEG/PNG/GIF/WebP only |
| Image after re-encode | WebP q60, longest edge 1280px |
| Images per room | 30 MB |
| Images server-wide | 500 MB |
| Upload rate | 6 per minute, per member |

### API

| Route | Purpose |
| --- | --- |
| `POST /api/rooms` | Create a room, returns `{ code }` |
| `GET /api/rooms/:code` | Check a room exists, returns `{ code, online }` |
| `POST /api/rooms/:code/uploads` | Upload an image. Raw bytes, `x-litechat-token` header. Returns `{ id, w, h, url }` |
| `GET /i/:code/:id.webp` | Serve an image (only when `IMAGE_BASE_URL` is unset) |
| `GET /api/health` | `{ ok, rooms, persistent, uploads }` |
| `WS /` | Chat protocol: `join` / `msg` / `typing` in, `joined` / `msg` / `system` / `presence` / `typing` / `error` out |

## Images

Uploads go over HTTP rather than the WebSocket, so a large file cannot stall the chat and the
client can show real progress. Every image is decoded and re-encoded to WebP before it touches
disk; the bytes as uploaded are never stored. That is a security boundary, not a size
optimisation:

- **EXIF is discarded.** Phone photos carry GPS coordinates, which have no business on a chat
  that promises anonymity.
- **Payloads are destroyed.** A file that is both a valid image and a valid script does not
  survive a round trip through a decoder. SVG is rejected outright - it is a script-capable
  document, not an image.
- **Bombs are refused before decoding**, on declared pixel count rather than after the memory
  has been allocated.

In production, set `IMAGE_BASE_URL` so images are served from a **separate hostname**. Then
anything that somehow survived re-encoding still cannot reach the app's DOM, storage or session,
because the browser treats it as a different origin. Locally the app serves them itself, which is
convenient but gives up that separation.

Images die with the message that references them: when a room expires, when the 500-message cap
evicts a message, and - via an hourly reconciliation pass - when an upload's message was never
sent at all.

### Building with sharp

sharp is the only native dependency. It is loaded dynamically, so if its binary is missing or
wrong for the platform, **uploads switch off and the chat keeps running** rather than the server
failing to start. `/api/health` reports which.

`npm ci` installs exactly what the lockfile names, so a lockfile generated on Windows will not
carry the Linux binary. The lockfile here already includes every platform; if you regenerate it,
re-add the deployment target:

```powershell
npm install --cpu=arm64 --os=linux --libc=glibc sharp
```

The Docker image uses `node:20-slim` rather than Alpine deliberately: sharp's glibc builds are
its best-supported target, and musl on ARM64 is the least tested combination.

## What this is not

There are no accounts and no end-to-end encryption — **the server can read every message and
every image**, and anyone with a 4-character code can read the room. Uploads are unauthenticated
beyond room membership, so a public instance is a place strangers can put files on your domain.
It is built for throwaway conversations, not for secrets.

## License

MIT
