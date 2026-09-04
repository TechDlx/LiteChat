import { randomInt, randomUUID } from 'node:crypto';
import { pickName, hueFor } from './names.js';
import { loadSnapshot, requestSave, saveNow, persistent } from './store.js';
import * as uploads from './uploads.js';

// 32 unambiguous characters: no I, O, 0 or 1. 32^4 = 1,048,576 possible codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

export const LIMITS = {
  idleMs: 30 * 24 * 60 * 60 * 1000, // room dies after 30 days with no activity
  maxMessages: 500,                 // retained per room
  maxMembers: 100,                  // distinct identities per room
  maxTextLen: 2000
};

/** code -> room */
const rooms = new Map();

/*
 * room = {
 *   code, createdAt, lastActivityAt,
 *   messages: [{ id, userId, name, hue, text, ts, image?: { id, w, h } }],
 *   members: Map(token -> { id, name, hue, seenAt, conns: Set<ws> })
 * }
 */

function normalise(code) {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code) {
  const c = normalise(code);
  if (c.length !== CODE_LEN) return false;
  return [...c].every((ch) => ALPHABET.includes(ch));
}

function newCode() {
  for (let i = 0; i < 500; i++) {
    let c = '';
    for (let j = 0; j < CODE_LEN; j++) c += ALPHABET[randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('code space exhausted');
}

export function createRoom() {
  const code = newCode();
  const now = Date.now();
  rooms.set(code, {
    code,
    createdAt: now,
    lastActivityAt: now,
    messages: [],
    members: new Map()
  });
  persist();
  return code;
}

export function getRoom(code) {
  const room = rooms.get(normalise(code));
  if (!room) return null;
  if (Date.now() - room.lastActivityAt > LIMITS.idleMs) {
    rooms.delete(room.code);
    uploads.removeRoom(room.code);
    persist();
    return null;
  }
  return room;
}

export function roomCount() {
  return rooms.size;
}

function touch(room) {
  room.lastActivityAt = Date.now();
}

/**
 * Attach a socket to a room, reusing the identity behind `token` when the
 * client has one (so a refresh keeps the same name).
 */
export function join(room, token, ws) {
  let member = token ? room.members.get(token) : null;

  if (!member) {
    const active = [...room.members.values()].filter((m) => m.conns.size > 0);
    if (active.length >= LIMITS.maxMembers) return { error: 'room_full' };

    const taken = new Set([...room.members.values()].map((m) => m.name));
    const id = randomUUID();
    const name = pickName(taken);
    member = { id, name, hue: hueFor(id + name), seenAt: Date.now(), conns: new Set() };
    token = randomUUID();
    room.members.set(token, member);
    pruneIdentities(room);
  }

  const wasOffline = member.conns.size === 0;
  member.conns.add(ws);
  member.seenAt = Date.now();
  touch(room);
  persist();
  return { token, member, announce: wasOffline };
}

export function leave(room, token, ws) {
  const member = room.members.get(token);
  if (!member) return { member: null, announce: false };
  member.conns.delete(ws);
  member.seenAt = Date.now();
  return { member, announce: member.conns.size === 0 };
}

/**
 * @param {object|null} image { id, w, h } for an image message, else null.
 */
export function addMessage(room, member, text, image = null) {
  const msg = {
    id: randomUUID(),
    userId: member.id,
    name: member.name,
    hue: member.hue,
    text,
    ts: Date.now()
  };
  if (image) msg.image = image;

  room.messages.push(msg);

  if (room.messages.length > LIMITS.maxMessages) {
    const dropped = room.messages.splice(0, room.messages.length - LIMITS.maxMessages);
    // An evicted message's image has nothing left pointing at it.
    for (const m of dropped) {
      if (m.image) uploads.remove(room.code, m.image.id);
    }
  }

  touch(room);
  persist();
  return msg;
}

/** Members with at least one live socket, for the presence list. */
export function onlineMembers(room) {
  return [...room.members.values()]
    .filter((m) => m.conns.size > 0)
    .map((m) => ({ id: m.id, name: m.name, hue: m.hue }));
}

/** Every open socket in the room, for broadcasting. */
export function sockets(room) {
  const out = [];
  for (const m of room.members.values()) for (const ws of m.conns) out.push(ws);
  return out;
}

/** Drop the oldest disconnected identities once a room accumulates too many. */
function pruneIdentities(room) {
  const cap = LIMITS.maxMembers * 2;
  if (room.members.size <= cap) return;
  const stale = [...room.members.entries()]
    .filter(([, m]) => m.conns.size === 0)
    .sort((a, b) => a[1].seenAt - b[1].seenAt);
  let excess = room.members.size - cap;
  for (const [token] of stale) {
    if (excess-- <= 0) break;
    room.members.delete(token);
  }
}

/** Delete rooms idle for longer than the retention window. Returns count removed. */
export function sweepExpired() {
  const cutoff = Date.now() - LIMITS.idleMs;
  let removed = 0;
  for (const [code, room] of rooms) {
    if (room.lastActivityAt < cutoff) {
      for (const ws of sockets(room)) {
        try { ws.close(4001, 'room expired'); } catch { /* already gone */ }
      }
      rooms.delete(code);
      uploads.removeRoom(code);   // the room's images die with it
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

/**
 * Every image id still referenced by a live message, grouped by room.
 * Live rooms with no images appear with an empty Set, which is what tells the
 * reconciler the directory is current rather than abandoned.
 */
export function referencedImages() {
  const out = new Map();
  for (const room of rooms.values()) {
    const ids = new Set();
    for (const m of room.messages) if (m.image) ids.add(m.image.id);
    out.set(room.code, ids);
  }
  return out;
}

/* ---------- persistence ---------- */

function serialise() {
  return {
    version: 1,
    savedAt: Date.now(),
    rooms: [...rooms.values()].map((room) => ({
      code: room.code,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      messages: room.messages,
      members: [...room.members.entries()].map(([token, m]) => ({
        token, id: m.id, name: m.name, hue: m.hue, seenAt: m.seenAt
      }))
    }))
  };
}

function persist() {
  requestSave(serialise);
}

export function flush() {
  saveNow(serialise);
}

export function restore() {
  const snap = loadSnapshot();
  if (!snap || !Array.isArray(snap.rooms)) return 0;
  const cutoff = Date.now() - LIMITS.idleMs;
  for (const r of snap.rooms) {
    if (!r || typeof r.code !== 'string' || r.lastActivityAt < cutoff) continue;
    const members = new Map();
    for (const m of r.members || []) {
      members.set(m.token, { id: m.id, name: m.name, hue: m.hue, seenAt: m.seenAt, conns: new Set() });
    }
    rooms.set(r.code, {
      code: r.code,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      messages: Array.isArray(r.messages) ? r.messages : [],
      members
    });
  }
  return rooms.size;
}

export { persistent };
