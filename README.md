# LiteChat

Temporary, disposable chat rooms. Create a room, get a 4-character code, share it.
No accounts, no email, no tracking. A room disappears once it has been idle for 30 days.

- **4-character codes** from a 32-symbol alphabet with no ambiguous characters (no `I`, `O`, `0`, `1`) — about 1,048,576 combinations.
- **Random names** — everyone is assigned something like `SwiftOtter` on join. A refresh keeps your name for the session.
- **30-day idle expiry** — every message or join resets the clock. An hourly sweep deletes rooms past the window.
- **One dependency** (`ws`), no build step, no database server.

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

An always-on VM with a real disk, so the 30-day lifetime means what it says.

```bash
# on the VM, after installing Docker + the compose plugin
git clone <your-repo> litechat && cd litechat
docker compose up -d --build
```

Then put [Caddy](https://caddyserver.com/) in front for automatic HTTPS — a two-line `Caddyfile`:

```
chat.example.com {
  reverse_proxy localhost:3000
}
```

Caddy proxies WebSocket upgrades without extra configuration.

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
| [public/](public/) | The entire frontend — three files, no build |

### Limits

| Thing | Cap |
| --- | --- |
| Message length | 2,000 characters |
| Messages retained per room | 500 (oldest dropped) |
| Concurrent members per room | 100 |
| Send rate | 20 messages per 10 seconds, per connection |
| Room lifetime | 30 days after the last activity |

### API

| Route | Purpose |
| --- | --- |
| `POST /api/rooms` | Create a room, returns `{ code }` |
| `GET /api/rooms/:code` | Check a room exists, returns `{ code, online }` |
| `GET /api/health` | `{ ok, rooms, persistent }` |
| `WS /` | Chat protocol: `join` / `msg` / `typing` in, `joined` / `msg` / `system` / `presence` / `typing` / `error` out |

## What this is not

There are no accounts, no file uploads, and no end-to-end encryption — **the server can read
every message**, and anyone with a 4-character code can read the room. It is built for throwaway
conversations, not for secrets.

## License

MIT
