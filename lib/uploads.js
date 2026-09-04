import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as encoder from './encode.js';

export const LIMITS = {
  maxUploadBytes: 3 * 1024 * 1024,   // what a client may POST
  maxPixels: 64_000_000,             // 8000 x 8000, checked before decoding
  maxEdge: 1280,                     // longest edge after resize
  quality: 60,                       // WebP quality - preview grade, not archival
  perRoomBytes: 30 * 1024 * 1024,
  globalBytes: 500 * 1024 * 1024,
  rateMax: 6,                        // uploads per window, per member
  rateWindowMs: 60_000,
  orphanGraceMs: 10 * 60 * 1000      // how long an unreferenced file is left alone
};

/*
 * UPLOADS=off            -> disabled outright
 * UPLOADS_DIR=/some/path -> explicit location
 * otherwise              -> <DATA_DIR>/uploads, or disabled when DATA_DIR is unset
 *                           (memory-only deployments have nowhere to put files)
 */
const DIR = process.env.UPLOADS === 'off'
  ? ''
  : (process.env.UPLOADS_DIR
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : ''));

// `let` so that useEncoder() can enable the path when sharp is absent.
export let enabled = Boolean(DIR) && encoder.available;

/** Where clients fetch images from. Unset means the app serves them itself. */
export const baseUrl = process.env.IMAGE_BASE_URL || '/i';

export const disabledReason = DIR
  ? (encoder.available ? '' : `sharp unavailable (${encoder.unavailableReason})`)
  : 'no writable uploads directory (set DATA_DIR or UPLOADS_DIR)';

const ID_RE = /^[0-9a-f]{32}$/;
const FILE_RE = /^([0-9a-f]{32})\.webp$/;
const CODE_RE = /^[A-Z0-9]{4}$/;

/** code -> bytes currently stored. Rebuilt from disk at startup. */
const usage = new Map();
let total = 0;

/** id -> { code, w, h }, kept between upload and the message that references it. */
const pending = new Map();

/** Swappable so the upload path can be exercised without a native encoder. */
let encodeImage = encoder.encodeImage;
export function useEncoder(fn) {
  encodeImage = fn;
  enabled = Boolean(DIR);
}

export function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

function dirFor(code) { return path.join(DIR, code); }
function fileFor(code, id) { return path.join(dirFor(code), `${id}.webp`); }

function adjust(code, delta) {
  const next = (usage.get(code) || 0) + delta;
  if (next > 0) usage.set(code, next); else usage.delete(code);
  total = Math.max(0, total + delta);
}

/** Create the directory and rebuild usage counters by walking what is there. */
export function init() {
  if (!enabled) return { enabled: false, reason: disabledReason };
  fs.mkdirSync(DIR, { recursive: true });
  usage.clear();
  total = 0;
  for (const code of fs.readdirSync(DIR)) {
    const dir = path.join(DIR, code);
    let sum = 0;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) sum += st.size;
      }
    } catch { continue; }
    if (sum) { usage.set(code, sum); total += sum; }
  }
  return { enabled: true, rooms: usage.size, bytes: total };
}

/**
 * Identify the format from the leading bytes. The client's filename and
 * Content-Type are not evidence of anything. SVG is deliberately absent: it is
 * a script-capable document, not an image.
 */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* ---------------- rate limiting ---------------- */

const hits = new Map(); // token -> timestamps

export function overRateLimit(token) {
  const now = Date.now();
  const list = (hits.get(token) || []).filter((t) => now - t < LIMITS.rateWindowMs);
  if (list.length >= LIMITS.rateMax) { hits.set(token, list); return true; }
  list.push(now);
  hits.set(token, list);
  return false;
}

/* ---------------- store ---------------- */

/**
 * Validate, re-encode and write. Returns { id, w, h, bytes } or { error }.
 * The uploaded bytes are discarded either way.
 */
export async function store(code, buf) {
  if (!enabled) return { error: 'uploads_disabled' };
  if (!CODE_RE.test(code)) return { error: 'invalid_code' };
  if (!buf || !buf.length) return { error: 'empty' };
  if (buf.length > LIMITS.maxUploadBytes) return { error: 'too_large' };
  if (!sniff(buf)) return { error: 'unsupported_type' };
  if ((usage.get(code) || 0) >= LIMITS.perRoomBytes) return { error: 'room_quota' };
  if (total >= LIMITS.globalBytes) return { error: 'server_full' };

  let out;
  try {
    out = await encodeImage(buf, {
      maxEdge: LIMITS.maxEdge,
      quality: LIMITS.quality,
      maxPixels: LIMITS.maxPixels
    });
  } catch {
    return { error: 'decode_failed' };
  }

  const id = randomBytes(16).toString('hex');
  const dir = dirFor(code);
  await fsp.mkdir(dir, { recursive: true });

  // Write to a temporary name and rename, so a half-written file is never
  // visible to the static file server.
  const tmp = path.join(dir, `.${id}.tmp`);
  await fsp.writeFile(tmp, out.data);
  await fsp.rename(tmp, fileFor(code, id));

  adjust(code, out.data.length);
  pending.set(id, { code, w: out.width, h: out.height });

  return { id, w: out.width, h: out.height, bytes: out.data.length };
}

/** Dimensions recorded at upload time, consumed when the message is created. */
export function claim(code, id) {
  const p = pending.get(id);
  if (!p || p.code !== code) return null;
  pending.delete(id);
  return { w: p.w, h: p.h };
}

export function exists(code, id) {
  if (!enabled || !isValidId(id) || !CODE_RE.test(code)) return false;
  try { return fs.statSync(fileFor(code, id)).isFile(); } catch { return false; }
}

/** Absolute path for serving, or '' if the request is not valid. */
export function pathFor(code, id) {
  if (!enabled || !isValidId(id) || !CODE_RE.test(code)) return '';
  return fileFor(code, id);
}

export function urlFor(code, id) {
  return `${baseUrl}/${code}/${id}.webp`;
}

/* ---------------- removal ---------------- */

export async function remove(code, id) {
  if (!enabled || !isValidId(id) || !CODE_RE.test(code)) return false;
  pending.delete(id);
  try {
    const p = fileFor(code, id);
    const st = await fsp.stat(p);
    await fsp.unlink(p);
    adjust(code, -st.size);
    return true;
  } catch { return false; }
}

/** Delete a room's entire image directory. Called when the room dies. */
export async function removeRoom(code) {
  if (!enabled || !CODE_RE.test(code)) return 0;
  const dir = dirFor(code);
  let count = 0;
  try {
    for (const f of await fsp.readdir(dir)) {
      const m = f.match(FILE_RE);
      if (m) pending.delete(m[1]);
      count++;
    }
    await fsp.rm(dir, { recursive: true, force: true });
  } catch { return 0; }
  total = Math.max(0, total - (usage.get(code) || 0));
  usage.delete(code);
  return count;
}

/**
 * Delete anything no live message points at. Three things orphan a file: a
 * room expiring, the 500-message cap evicting a message, and an upload whose
 * message was never sent. Only the third needs this pass, but it costs nothing
 * to catch all three.
 *
 * @param {Map<string, Set<string>>} referenced code -> ids still in use.
 *        A live room with no images must still appear, with an empty Set.
 */
export async function reconcile(referenced) {
  if (!enabled) return 0;
  const cutoff = Date.now() - LIMITS.orphanGraceMs;
  let removed = 0;

  let codes;
  try { codes = await fsp.readdir(DIR); } catch { return 0; }

  for (const code of codes) {
    const dir = path.join(DIR, code);
    try { if (!(await fsp.stat(dir)).isDirectory()) continue; } catch { continue; }

    const keep = referenced.get(code);
    if (!keep) { removed += await removeRoom(code); continue; }

    let files;
    try { files = await fsp.readdir(dir); } catch { continue; }

    for (const f of files) {
      const p = path.join(dir, f);
      let st;
      try { st = await fsp.stat(p); } catch { continue; }
      if (!st.isFile()) continue;

      const m = f.match(FILE_RE);
      if (m && keep.has(m[1])) continue;
      if (st.mtimeMs > cutoff) continue;   // may still be in flight

      try {
        await fsp.unlink(p);
        adjust(code, -st.size);
        if (m) pending.delete(m[1]);
        removed++;
      } catch { /* raced with another delete */ }
    }
  }
  return removed;
}

export function stats() {
  return { enabled, rooms: usage.size, bytes: total, limitBytes: LIMITS.globalBytes };
}
