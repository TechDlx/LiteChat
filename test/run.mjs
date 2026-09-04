/**
 * End-to-end tests. Runs the real server in-process against a temporary data
 * directory, with a stub image encoder swapped in so the upload path can be
 * exercised without sharp's native binary.
 *
 *   npm test
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'litechat-test-'));

process.env.PORT = String(PORT);
process.env.HOST = '127.0.0.1';
process.env.DATA_DIR = TMP;
delete process.env.IMAGE_BASE_URL;   // exercise the app's own /i route

// Modules read env at load time, so import only after setting it.
const U = await import(`file://${path.join(ROOT, 'lib/uploads.js')}`);
const R = await import(`file://${path.join(ROOT, 'lib/rooms.js')}`);

/** Stands in for sharp: records the call, returns a fixed-size "image". */
let encodeCalls = 0;
U.useEncoder(async (buf, opts) => {
  encodeCalls++;
  if (buf.length < 12) throw new Error('too small to decode');
  return { data: Buffer.alloc(2048, 7), width: Math.min(opts.maxEdge, 900), height: 600 };
});

await import(`file://${path.join(ROOT, 'server.js')}`);

/* ---------------- harness ---------------- */

let failures = 0;
let checks = 0;

function check(label, cond, extra) {
  checks++;
  if (cond) { console.log(`  PASS  ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`);
}

function section(name) { console.log(`\n${name}`); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 2000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await fn()) return true;
    await wait(25);
  }
  return false;
}

function request(method, pathname, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(d)));
  return {
    ws,
    got,
    open: new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    find: (t) => got.find((m) => m.t === t),
    last: (t) => [...got].reverse().find((m) => m.t === t),
    all: (t) => got.filter((m) => m.t === t)
  };
}

/** Valid PNG magic bytes plus filler - enough to pass sniffing. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4096, 1)
]);
const NOT_AN_IMAGE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

async function join(code) {
  const c = client();
  await c.open;
  c.send({ t: 'join', code });
  await until(() => c.find('joined'));
  return c;
}

/* ---------------- tests ---------------- */

await wait(300);   // let the server bind

section('chat basics still work');
{
  const health = await request('GET', '/api/health');
  check('health reports uploads enabled', health.body?.uploads?.enabled === true, health.body);

  const created = await request('POST', '/api/rooms');
  const code = created.body.code;
  check('room code is 4 unambiguous chars', /^[A-HJ-NP-Z2-9]{4}$/.test(code || ''), created.body);

  const a = await join(code);
  const b = await join(code);
  check('two members get different names',
    a.find('joined').you.name !== b.find('joined').you.name);

  a.send({ t: 'msg', text: 'hello' });
  await until(() => b.all('msg').length);
  check('text message reaches the other client', b.all('msg')[0].msg.text === 'hello');
  check('text message carries no image', b.all('msg')[0].msg.image === undefined);

  a.ws.close(); b.ws.close();
}

section('upload authorisation');
let roomA, tokenA, clientA;
{
  roomA = (await request('POST', '/api/rooms')).body.code;
  clientA = await join(roomA);
  tokenA = clientA.find('joined').token;

  const noToken = await request('POST', `/api/rooms/${roomA}/uploads`, { body: PNG });
  check('upload without a token is rejected', noToken.status === 401, noToken.status);

  const badToken = await request('POST', `/api/rooms/${roomA}/uploads`, {
    body: PNG, headers: { 'x-litechat-token': 'not-a-real-token' }
  });
  check('upload with a bogus token is rejected', badToken.status === 401, badToken.status);

  const noRoom = await request('POST', '/api/rooms/ZZZZ/uploads', {
    body: PNG, headers: { 'x-litechat-token': tokenA }
  });
  check('upload to a missing room is rejected', noRoom.status === 404, noRoom.status);
}

section('upload validation');
let imageId;
{
  const svg = await request('POST', `/api/rooms/${roomA}/uploads`, {
    body: NOT_AN_IMAGE, headers: { 'x-litechat-token': tokenA }
  });
  check('SVG is rejected on magic bytes', svg.status === 415 && svg.body.error === 'unsupported_type', svg.body);

  const huge = await request('POST', `/api/rooms/${roomA}/uploads`, {
    body: Buffer.alloc(U.LIMITS.maxUploadBytes + 1024, 5),
    headers: { 'x-litechat-token': tokenA }
  });
  check('oversized upload is refused', huge.status === 413, huge.status);

  const before = encodeCalls;
  const ok = await request('POST', `/api/rooms/${roomA}/uploads`, {
    body: PNG, headers: { 'x-litechat-token': tokenA }
  });
  imageId = ok.body?.id;
  check('valid image is accepted', ok.status === 201 && /^[0-9a-f]{32}$/.test(imageId || ''), ok.body);
  check('response carries dimensions', ok.body?.w === 900 && ok.body?.h === 600, ok.body);
  check('image was re-encoded, not stored as sent', encodeCalls === before + 1);

  const onDisk = path.join(TMP, 'uploads', roomA, `${imageId}.webp`);
  check('file landed in the room directory', fs.existsSync(onDisk), onDisk);
  check('no temp file left behind',
    fs.readdirSync(path.join(TMP, 'uploads', roomA)).every((f) => !f.endsWith('.tmp')));
}

section('sending an image message');
{
  const viewer = await join(roomA);
  clientA.send({ t: 'msg', imageId, text: 'look at this' });
  await until(() => viewer.all('msg').length);

  const msg = viewer.all('msg')[0].msg;
  check('image message broadcasts to the room', msg?.image?.id === imageId, msg);
  check('server supplies the dimensions', msg.image.w === 900 && msg.image.h === 600, msg.image);
  check('caption rides along', msg.text === 'look at this');

  const fake = 'a'.repeat(32);
  clientA.send({ t: 'msg', imageId: fake });
  await until(() => clientA.all('error').length);
  check('fabricated image id is refused',
    clientA.all('error').some((e) => e.code === 'image_missing'), clientA.all('error'));

  // A second room must not be able to reference room A's image.
  const roomB = (await request('POST', '/api/rooms')).body.code;
  const inB = await join(roomB);
  inB.send({ t: 'msg', imageId });
  await until(() => inB.all('error').length);
  check('image ids do not cross rooms',
    inB.all('error').some((e) => e.code === 'image_missing'), inB.all('error'));

  viewer.ws.close(); inB.ws.close();
}

section('serving');
{
  const res = await request('GET', `/i/${roomA}/${imageId}.webp`);
  check('image is served', res.status === 200, res.status);
  check('served as image/webp', res.headers['content-type'] === 'image/webp', res.headers['content-type']);
  check('nosniff is set', res.headers['x-content-type-options'] === 'nosniff');
  check('sandboxed by CSP', /sandbox/.test(res.headers['content-security-policy'] || ''));
  check('cached immutably', /immutable/.test(res.headers['cache-control'] || ''));

  const traversal = await request('GET', `/i/${roomA}/..%2f..%2frooms.json`);
  const leaked = traversal.raw.toString('utf8');
  check('traversal cannot reach the room snapshot',
    !leaked.includes('lastActivityAt') && !leaked.includes('"members"'), traversal.status);

  const up = await request('GET', '/../package.json');
  check('traversal cannot escape the public directory',
    !up.raw.toString('utf8').includes('"litechat"'), up.status);

  const missing = await request('GET', `/i/${roomA}/${'b'.repeat(32)}.webp`);
  check('unknown image is a 404', missing.status === 404, missing.status);
}

section('rate limiting');
{
  const c = await join(roomA);
  const t = c.find('joined').token;
  let limited = false;
  for (let i = 0; i < U.LIMITS.rateMax + 2; i++) {
    const r = await request('POST', `/api/rooms/${roomA}/uploads`, {
      body: PNG, headers: { 'x-litechat-token': t }
    });
    if (r.status === 429) { limited = true; break; }
  }
  check('upload rate limit engages', limited);
  c.ws.close();
}

section('lifecycle: eviction, room death, orphans');
{
  // An image whose message is pushed out by the 500-message cap.
  const code = (await request('POST', '/api/rooms')).body.code;
  const c = await join(code);
  const tok = c.find('joined').token;
  const up = await request('POST', `/api/rooms/${code}/uploads`, {
    body: PNG, headers: { 'x-litechat-token': tok }
  });
  const evictId = up.body.id;
  const evictPath = path.join(TMP, 'uploads', code, `${evictId}.webp`);
  c.send({ t: 'msg', imageId: evictId });
  await until(() => fs.existsSync(evictPath) && c.all('msg').length);

  const room = R.getRoom(code);
  const member = [...room.members.values()][0];
  for (let i = 0; i < R.LIMITS.maxMessages + 1; i++) R.addMessage(room, member, `filler ${i}`);
  check('evicting a message deletes its image', await until(() => !fs.existsSync(evictPath)), evictPath);
  c.ws.close();

  // Room deletion takes the whole directory.
  const dir = path.join(TMP, 'uploads', roomA);
  check('room directory exists before deletion', fs.existsSync(dir));
  await U.removeRoom(roomA);
  check('deleting a room deletes its images', !fs.existsSync(dir));

  // An upload whose message was never sent, aged past the grace window.
  const orphanRoom = (await request('POST', '/api/rooms')).body.code;
  const oc = await join(orphanRoom);
  const otok = oc.find('joined').token;
  const orphan = await request('POST', `/api/rooms/${orphanRoom}/uploads`, {
    body: PNG, headers: { 'x-litechat-token': otok }
  });
  const orphanPath = path.join(TMP, 'uploads', orphanRoom, `${orphan.body.id}.webp`);
  check('orphan file exists', fs.existsSync(orphanPath));

  await U.reconcile(R.referencedImages());
  check('recent orphan is left alone during the grace window', fs.existsSync(orphanPath));

  const old = new Date(Date.now() - U.LIMITS.orphanGraceMs - 60_000);
  fs.utimesSync(orphanPath, old, old);
  const removed = await U.reconcile(R.referencedImages());
  check('aged orphan is reclaimed', !fs.existsSync(orphanPath) && removed >= 1, removed);

  // A directory belonging to no live room at all.
  const ghost = path.join(TMP, 'uploads', 'GHST');
  await fsp.mkdir(ghost, { recursive: true });
  await fsp.writeFile(path.join(ghost, `${'c'.repeat(32)}.webp`), Buffer.alloc(16));
  await U.reconcile(R.referencedImages());
  check('directory for a dead room is removed', !fs.existsSync(ghost));

  oc.ws.close();
}

section('accounting');
{
  const health = await request('GET', '/api/health');
  check('usage is reported and non-negative', (health.body?.uploads?.bytes ?? -1) >= 0, health.body?.uploads);
  check('global limit is exposed', health.body?.uploads?.limitBytes === U.LIMITS.globalBytes);
}

/* ---------------- report ---------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows file locks */ }
process.exit(failures ? 1 : 0);
