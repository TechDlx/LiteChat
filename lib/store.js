import fs from 'node:fs';
import path from 'node:path';

/**
 * Snapshot persistence.
 *
 * DATA_DIR unset  -> memory only; rooms vanish on restart (fine for free tiers
 *                    with no disk).
 * DATA_DIR set    -> rooms.json is written atomically a few seconds after any
 *                    change, and on shutdown.
 */
const DATA_DIR = process.env.DATA_DIR || '';
const FILE = DATA_DIR ? path.join(DATA_DIR, 'rooms.json') : '';
const SAVE_DEBOUNCE_MS = 5000;

export const persistent = Boolean(DATA_DIR);

let timer = null;
let getData = null;

export function loadSnapshot() {
  if (!persistent) return null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[store] could not read snapshot, starting empty:', err.message);
    return null;
  }
}

function write() {
  timer = null;
  if (!persistent || !getData) return;
  try {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(getData()));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[store] save failed:', err.message);
  }
}

/** Mark state dirty; the actual write is debounced. */
export function requestSave(fn) {
  if (!persistent) return;
  getData = fn;
  if (timer) return;
  timer = setTimeout(write, SAVE_DEBOUNCE_MS);
  if (timer.unref) timer.unref();
}

/** Flush immediately (shutdown path). */
export function saveNow(fn) {
  if (!persistent) return;
  if (fn) getData = fn;
  if (timer) clearTimeout(timer);
  write();
}
