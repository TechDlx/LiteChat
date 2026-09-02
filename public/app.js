const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP_WINDOW = 3 * 60 * 1000; // messages closer than this are visually grouped

const $ = (id) => document.getElementById(id);

const landing = $('landing');
const roomView = $('room');
const boxes = [...$('codeBoxes').querySelectorAll('.code-box')];
const messagesEl = $('messages');
const emptyState = $('emptyState');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const typingEl = $('typing');

let ws = null;
let code = null;
let me = null;
let lastRow = null;      // { userId, ts, el } for grouping
let typers = new Set();
let typingSent = false;
let typingTimer = null;
let retries = 0;
let reconnectTimer = null;
let deliberateLeave = false;

/* ---------------- helpers ---------------- */

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function showError(text) {
  const el = $('landingError');
  el.textContent = text;
  el.hidden = !text;
}

const ERRORS = {
  invalid_code: 'That code does not look right.',
  not_found: 'No room with that code. It may have expired.',
  room_full: 'That room is full.',
  rate_limited: 'Slow down a moment.'
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Escape first, then turn bare http(s) links into anchors.
function linkify(text) {
  return escapeHtml(text).replace(/\bhttps?:\/\/[^\s<]+/g, (url) => {
    const trimmed = url.replace(/[.,;:!?)\]]+$/, '');
    const tail = url.slice(trimmed.length);
    return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>${tail}`;
  });
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function tokenKey(c) { return `litechat:token:${c}`; }

function readToken(c) {
  try { return sessionStorage.getItem(tokenKey(c)); } catch { return null; }
}

function writeToken(c, t) {
  try { sessionStorage.setItem(tokenKey(c), t); } catch { /* private mode; name just won't survive a refresh */ }
}

/* ---------------- code input ---------------- */

function currentCode() {
  return boxes.map((b) => b.value).join('').toUpperCase();
}

function syncJoinButton() {
  $('joinBtn').disabled = currentCode().length !== 4;
}

boxes.forEach((box, i) => {
  box.addEventListener('input', () => {
    const ch = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    box.value = ALPHABET.includes(ch) ? ch : '';
    if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    showError('');
    syncJoinButton();
  });

  box.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !box.value && i > 0) {
      boxes[i - 1].focus();
      boxes[i - 1].value = '';
      syncJoinButton();
      e.preventDefault();
    }
    if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
    if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
  });

  box.addEventListener('paste', (e) => {
    e.preventDefault();
    fillCode((e.clipboardData || window.clipboardData).getData('text'));
  });
});

function fillCode(raw) {
  const chars = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').split('')
    .filter((c) => ALPHABET.includes(c)).slice(0, 4);
  boxes.forEach((b, i) => { b.value = chars[i] || ''; });
  boxes[Math.min(chars.length, 3)].focus();
  syncJoinButton();
}

/* ---------------- landing actions ---------------- */

$('createBtn').addEventListener('click', async () => {
  const btn = $('createBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('create failed');
    const { code: newCode } = await res.json();
    enterRoom(newCode);
  } catch {
    showError('Could not create a room. Try again.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create a room';
  }
});

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = currentCode();
  if (c.length === 4) enterRoom(c);
});

/* ---------------- room ---------------- */

function enterRoom(c) {
  code = c;
  location.hash = c;
  showError('');
  landing.hidden = true;
  roomView.hidden = false;
  $('roomCode').textContent = c;
  document.title = `${c} · LiteChat`;
  resetMessages();
  connect();
}

function exitRoom(reason) {
  deliberateLeave = true;
  clearTimeout(reconnectTimer);
  if (ws) { ws.close(); ws = null; }
  code = null;
  me = null;
  history.replaceState(null, '', location.pathname);
  roomView.hidden = true;
  landing.hidden = false;
  document.title = 'LiteChat';
  boxes.forEach((b) => { b.value = ''; });
  syncJoinButton();
  if (reason) showError(reason);
}

$('leaveBtn').addEventListener('click', () => exitRoom(''));

$('codeChip').addEventListener('click', async () => {
  const link = `${location.origin}/#${code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    toast(link);
  }
});

function resetMessages() {
  messagesEl.querySelectorAll('.row, .system').forEach((el) => el.remove());
  emptyState.hidden = false;
  lastRow = null;
  typers.clear();
  renderTyping();
}

/* ---------------- rendering ---------------- */

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(msg) {
  const stick = nearBottom();
  emptyState.hidden = true;

  const mine = me && msg.userId === me.id;
  const grouped = lastRow && lastRow.userId === msg.userId && msg.ts - lastRow.ts < GROUP_WINDOW;

  const row = document.createElement('div');
  row.className = `row ${mine ? 'mine' : 'theirs'}${grouped ? '' : ' first'}`;

  if (!grouped && !mine) {
    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = msg.name;
    author.style.setProperty('--author', `hsl(${msg.hue} 62% 45%)`);
    row.appendChild(author);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = linkify(msg.text);
  row.appendChild(bubble);

  const stamp = document.createElement('div');
  stamp.className = 'stamp';
  stamp.textContent = timeOf(msg.ts);
  row.appendChild(stamp);

  messagesEl.querySelector('.row.last')?.classList.remove('last');
  row.classList.add('last');

  messagesEl.appendChild(row);
  lastRow = { userId: msg.userId, ts: msg.ts };
  if (stick || mine) scrollToBottom();
}

function addSystem(text) {
  const stick = nearBottom();
  const el = document.createElement('div');
  el.className = 'system';
  el.textContent = text;
  messagesEl.appendChild(el);
  lastRow = null;
  if (stick) scrollToBottom();
}

function renderPresence(members) {
  $('onlineCount').textContent = members.length;
}

function renderTyping() {
  const names = [...typers];
  if (!names.length) { typingEl.textContent = ''; return; }
  if (names.length === 1) typingEl.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) typingEl.textContent = `${names[0]} and ${names[1]} are typing…`;
  else typingEl.textContent = 'Several people are typing…';
}

function setConnected(on) {
  document.querySelector('.pulse').classList.toggle('off', !on);
  inputEl.disabled = !on;
  syncSendButton();
}

/* ---------------- socket ---------------- */

function connect() {
  clearTimeout(reconnectTimer);
  deliberateLeave = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    retries = 0;
    ws.send(JSON.stringify({ t: 'join', code, token: readToken(code) }));
  });

  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    if (m.t === 'joined') {
      me = m.you;
      writeToken(m.code, m.token);
      $('youAre').textContent = `you are ${me.name}`;
      resetMessages();
      for (const msg of m.messages) addMessage(msg);
      renderPresence(m.members);
      setConnected(true);
      scrollToBottom();
      return;
    }

    if (m.t === 'msg') return addMessage(m.msg);

    if (m.t === 'system') {
      return addSystem(m.kind === 'join' ? `${m.name} joined` : `${m.name} left`);
    }

    if (m.t === 'presence') return renderPresence(m.members);

    if (m.t === 'typing') {
      if (m.on) typers.add(m.name); else typers.delete(m.name);
      return renderTyping();
    }

    if (m.t === 'error') {
      const text = ERRORS[m.code] || 'Something went wrong.';
      if (m.code === 'not_found' || m.code === 'invalid_code' || m.code === 'room_full') {
        return exitRoom(text);
      }
      toast(text);
    }
  });

  ws.addEventListener('close', () => {
    if (deliberateLeave || !code) return;
    setConnected(false);
    typers.clear();
    renderTyping();
    const delay = Math.min(1000 * 2 ** retries++, 15000);
    typingEl.textContent = 'Reconnecting…';
    reconnectTimer = setTimeout(connect, delay);
  });
}

/* ---------------- composing ---------------- */

function syncSendButton() {
  sendBtn.disabled = !inputEl.value.trim() || !ws || ws.readyState !== WebSocket.OPEN;
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

function signalTyping(on) {
  if (on === typingSent) return;
  typingSent = on;
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'typing', on }));
}

inputEl.addEventListener('input', () => {
  autoGrow();
  syncSendButton();
  signalTyping(Boolean(inputEl.value.trim()));
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => signalTyping(false), 4000);
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'msg', text }));
  inputEl.value = '';
  autoGrow();
  syncSendButton();
  clearTimeout(typingTimer);
  signalTyping(false);
});

/* ---------------- boot ---------------- */

window.addEventListener('hashchange', () => {
  const c = location.hash.slice(1).toUpperCase();
  if (c.length === 4 && c !== code) enterRoom(c);
  else if (!c && code) exitRoom('');
});

const initial = location.hash.slice(1).toUpperCase();
if (initial.length === 4 && [...initial].every((c) => ALPHABET.includes(c))) {
  enterRoom(initial);
} else {
  boxes[0].focus();
}
