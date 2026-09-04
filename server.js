import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as R from './lib/rooms.js';
import * as U from './lib/uploads.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// When IMAGE_BASE_URL is set, a separate host (Caddy) serves the files and this
// app must not, so that user content never shares an origin with the app.
const SERVE_IMAGES = !process.env.IMAGE_BASE_URL;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/* ---------------- HTTP helpers ---------------- */

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store'
  });
  res.end(data);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(buf);
  });
}

/**
 * Collect a request body, refusing anything over `max` without buffering it.
 *
 * Deliberately does not destroy the socket on refusal: killing it mid-upload
 * makes the client see a connection reset instead of the 413, so the caller
 * responds first and then drains.
 */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > max) { settled = true; reject(new Error('too_large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

/** Answer, then swallow whatever the client is still sending. */
function refuse(req, res, status, error) {
  sendJSON(res, status, { error });
  req.resume();
}

const UPLOAD_ERRORS = {
  too_large: 413,
  unsupported_type: 415,
  room_quota: 507,
  server_full: 507,
  uploads_disabled: 503,
  decode_failed: 400,
  empty: 400,
  invalid_code: 400
};

/* ---------------- routes ---------------- */

async function handleUpload(req, res, code) {
  if (!U.enabled) return refuse(req, res, 503, 'uploads_disabled');

  if (!R.isValidCode(code)) return refuse(req, res, 400, 'invalid_code');
  const room = R.getRoom(code);
  if (!room) return refuse(req, res, 404, 'not_found');

  // The session token is the only credential this app has. An upload must come
  // from someone who has actually joined the room.
  const token = req.headers['x-litechat-token'];
  if (typeof token !== 'string' || !room.members.has(token)) {
    return refuse(req, res, 401, 'not_a_member');
  }

  if (U.overRateLimit(token)) return refuse(req, res, 429, 'rate_limited');

  // Reject on the declared size before reading a byte, when we can.
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > U.LIMITS.maxUploadBytes) return refuse(req, res, 413, 'too_large');

  let buf;
  try {
    buf = await readBody(req, U.LIMITS.maxUploadBytes);
  } catch (err) {
    return refuse(req, res, err.message === 'too_large' ? 413 : 400, err.message === 'too_large' ? 'too_large' : 'bad_request');
  }

  const result = await U.store(room.code, buf);
  if (result.error) {
    return sendJSON(res, UPLOAD_ERRORS[result.error] || 400, { error: result.error });
  }

  sendJSON(res, 201, { id: result.id, w: result.w, h: result.h, url: U.urlFor(room.code, result.id) });
}

/** Only used when no separate image host is configured (local development). */
function serveImage(res, code, id) {
  const file = U.pathFor(code, id);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': buf.length,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'cross-origin'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      rooms: R.roomCount(),
      persistent: R.persistent,
      uploads: U.stats()
    });
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    try {
      return sendJSON(res, 201, { code: R.createRoom() });
    } catch {
      return sendJSON(res, 503, { error: 'could not allocate a room code' });
    }
  }

  const upload = pathname.match(/^\/api\/rooms\/([^/]+)\/uploads$/);
  if (upload && req.method === 'POST') {
    return handleUpload(req, res, upload[1].toUpperCase()).catch(() => {
      if (!res.headersSent) sendJSON(res, 500, { error: 'upload_failed' });
    });
  }

  const lookup = pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (lookup && req.method === 'GET') {
    const code = lookup[1].toUpperCase();
    if (!R.isValidCode(code)) return sendJSON(res, 400, { error: 'invalid_code' });
    const room = R.getRoom(code);
    if (!room) return sendJSON(res, 404, { error: 'not_found' });
    return sendJSON(res, 200, { code: room.code, online: R.onlineMembers(room).length });
  }

  const image = pathname.match(/^\/i\/([A-Z0-9]{4})\/([0-9a-f]{32})\.webp$/);
  if (image && req.method === 'GET') {
    if (!SERVE_IMAGES) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    return serveImage(res, image[1], image[2]);
  }

  // Static files. Anything unknown falls back to index.html so /#CODE links work.
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendFile(res, path.join(PUBLIC, 'index.html'));
    sendFile(res, file);
  });
});

/* ---------------- WebSocket ---------------- */

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload, except) {
  const data = JSON.stringify(payload);
  for (const ws of R.sockets(room)) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function presence(room) {
  broadcast(room, { t: 'presence', members: R.onlineMembers(room) });
}

// Rate limit: at most 20 messages in any 10 second window, per connection.
const RATE_WINDOW = 10000;
const RATE_MAX = 20;

function overLimit(ws) {
  const now = Date.now();
  ws.hits = (ws.hits || []).filter((t) => now - t < RATE_WINDOW);
  if (ws.hits.length >= RATE_MAX) return true;
  ws.hits.push(now);
  return false;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.token = null;
  ws.member = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (ws.room) return;
      if (!R.isValidCode(m.code)) return send(ws, { t: 'error', code: 'invalid_code' });
      const room = R.getRoom(m.code);
      if (!room) return send(ws, { t: 'error', code: 'not_found' });

      const res = R.join(room, typeof m.token === 'string' ? m.token : null, ws);
      if (res.error) return send(ws, { t: 'error', code: res.error });

      ws.room = room;
      ws.token = res.token;
      ws.member = res.member;

      send(ws, {
        t: 'joined',
        code: room.code,
        token: res.token,
        you: { id: res.member.id, name: res.member.name, hue: res.member.hue },
        members: R.onlineMembers(room),
        messages: room.messages,
        expiresAt: room.lastActivityAt + R.LIMITS.idleMs,
        uploads: {
          enabled: U.enabled,
          baseUrl: U.baseUrl,
          maxBytes: U.LIMITS.maxUploadBytes
        }
      });

      if (res.announce) {
        broadcast(room, { t: 'system', kind: 'join', name: res.member.name, ts: Date.now() }, ws);
      }
      presence(room);
      return;
    }

    if (!ws.room || !ws.member) return;

    if (m.t === 'msg') {
      const text = typeof m.text === 'string' ? m.text.trim() : '';

      let image = null;
      if (m.imageId) {
        // The id must name a file that really exists under this room. A client
        // cannot reference another room's image, or invent one.
        if (!U.isValidId(m.imageId) || !U.exists(ws.room.code, m.imageId)) {
          return send(ws, { t: 'error', code: 'image_missing' });
        }
        const dims = U.claim(ws.room.code, m.imageId) || { w: 0, h: 0 };
        image = { id: m.imageId, w: dims.w, h: dims.h };
      }

      if (!text && !image) return;
      if (overLimit(ws)) return send(ws, { t: 'error', code: 'rate_limited' });

      const msg = R.addMessage(ws.room, ws.member, text.slice(0, R.LIMITS.maxTextLen), image);
      broadcast(ws.room, { t: 'msg', msg });
      return;
    }

    if (m.t === 'typing') {
      broadcast(ws.room, { t: 'typing', name: ws.member.name, on: Boolean(m.on) }, ws);
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const { member, announce } = R.leave(ws.room, ws.token, ws);
    if (announce && member) {
      broadcast(ws.room, { t: 'system', kind: 'leave', name: member.name, ts: Date.now() });
      broadcast(ws.room, { t: 'typing', name: member.name, on: false });
    }
    presence(ws.room);
    ws.room = null;
  });

  ws.on('error', () => { /* the close handler does the cleanup */ });
});

// Drop half-open sockets so presence lists stay honest.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* terminated on the next pass */ }
  }
}, 30000);
if (heartbeat.unref) heartbeat.unref();

/* ---------------- lifecycle ---------------- */

const restored = R.restore();
const uploadState = U.init();

async function reconcileUploads() {
  if (!U.enabled) return;
  try {
    const n = await U.reconcile(R.referencedImages());
    if (n) console.log(`[uploads] removed ${n} orphaned file(s)`);
  } catch (err) {
    console.error('[uploads] reconcile failed:', err.message);
  }
}

const sweeper = setInterval(() => {
  const n = R.sweepExpired();
  if (n) console.log(`[sweep] removed ${n} expired room(s)`);
  reconcileUploads();
}, 60 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to something else, e.g. PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`LiteChat listening on http://${HOST}:${PORT}`);
  console.log(`storage: ${R.persistent ? `disk (DATA_DIR=${process.env.DATA_DIR})` : 'memory only - rooms reset on restart'}`);
  console.log(`uploads: ${U.enabled
    ? `on, served from ${U.baseUrl} (${(uploadState.bytes / 1048576).toFixed(1)} MB in use)`
    : `off - ${U.disabledReason}`}`);
  if (restored) console.log(`restored ${restored} room(s) from snapshot`);
  reconcileUploads();
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) process.exit(0);
    closing = true;
    console.log(`\n${sig} - flushing and shutting down`);
    R.flush();
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close(() => process.exit(0));
    const bail = setTimeout(() => process.exit(0), 3000);
    if (bail.unref) bail.unref();
  });
}
