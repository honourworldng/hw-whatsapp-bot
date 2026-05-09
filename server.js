// Honour World — Telegram bridge to Claude Code
// COO directive 6 May 2026 — replaces the WhatsApp/Baileys bot after
// Meta restricted the bot's WhatsApp account for "automated/bulk
// messaging" patterns. Telegram's Bot API is purpose-built for this
// use case (no SIM, no multi-device sessions, no Signal protocol, no
// Meta restrictions) — far more reliable.
//
// The bot:
//   1. Listens for /start → asks user to share phone number → matches
//      against the whitelist → stores their Telegram chat_id so future
//      messages can be routed to them.
//   2. Listens for /c <prompt> → spawns `claude -p` with per-user
//      session-id, replies with stdout. Read-only users get
//      --disallowedTools + system-prompt guard.
//   3. Exposes /send HTTP API on 127.0.0.1:9001 (loopback only, bearer
//      auth) for outbound alerts from retry-server crons. Backward
//      compatible with hw_wa_notify.py — accepts {to: phone, message}
//      and looks up the matching Telegram chat_id from the registered
//      users DB. If a recipient hasn't /start'd the bot yet, /send
//      returns 404 (alert delivered via existing email channel only).
//
// Config files (all root-owned 0600):
//   /etc/hw-tg-bot.token      — Telegram BotFather token
//   /etc/hw-wa-bot.token      — Bearer token for /send (kept the legacy
//                                name so hw_wa_notify.py works unchanged)
// State files:
//   /var/lib/hw-whatsapp-bot/tg-users.json  — registered users (telegramId
//                                        → {name, phone, permission, ...})
//   /var/log/hw-whatsapp-bot/claude-audit.log — every /c invocation

// CEO directive 8 May 2026 — sibling of the Telegram bot, but talking
// over WhatsApp via Baileys instead of the Telegram Bot API. Uses a
// thin shim so the rest of this file (command handlers, /send HTTP,
// admin proposal flow, etc.) is unchanged from hw-wa-bot.
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SHARED_TOKEN_FILE = process.env.HW_WA_TOKEN_FILE || '/etc/hw-whatsapp-bot.token';
const HTTP_PORT = Number(process.env.HW_WA_HTTP_PORT || 9002);
const USERS_DB_PATH = process.env.HW_WA_USERS_DB || '/var/lib/hw-whatsapp-bot/wa-users.json';
const AUTH_DIR = process.env.HW_WA_AUTH_DIR || '/var/lib/hw-whatsapp-bot/auth';
const QR_PNG = '/var/log/hw-whatsapp-bot/last-qr.png';
const PAIR_CODE_FILE = '/var/log/hw-whatsapp-bot/last-pairing-code.txt';
const BOT_NUMBER = process.env.HW_WA_BOT_NUMBER || '2348126728045';
const USE_PAIRING_CODE = String(process.env.HW_WA_PAIR_BY_CODE ?? '0') === '1';
const CLAUDE_BIN = process.env.HW_WA_CLAUDE_BIN || '/usr/bin/claude';
const CLAUDE_TRIGGER = process.env.HW_WA_CLAUDE_TRIGGER || '/c';
const CLAUDE_TIMEOUT_MS = Number(process.env.HW_WA_CLAUDE_TIMEOUT_MS || 300000);
const CLAUDE_AUDIT_LOG = process.env.HW_WA_CLAUDE_AUDIT_LOG || '/var/log/hw-whatsapp-bot/claude-audit.log';
const CLAUDE_RESPONSE_MAX = Number(process.env.HW_WA_CLAUDE_RESPONSE_MAX || 3500);
const HWBOT_UID = Number(process.env.HW_WA_HWBOT_UID || 998);
const HWBOT_GID = Number(process.env.HW_WA_HWBOT_GID || 997);
const HWBOT_HOME = process.env.HW_WA_HWBOT_HOME || "/home/hwbot";


// ── Wallet-funding plumbing (CEO directive 6 May 2026) ──────────────────────
// John & Bukunmi (both `permission:'full'`) are bot superadmins and may
// authorise wallet funding via the bot. The bot calls the api using
// THEIR OWN admin JWT (set via /setadmin), so audit trails on the api
// side correctly attribute every credit/debit to the human who
// authorised it. Every action requires explicit chat confirmation.
const HW_API_BASE = process.env.HW_API_BASE || 'https://api.honourworld.com';
const ADMIN_TOKENS_PATH = process.env.HW_TG_ADMIN_TOKENS || '/var/lib/hw-whatsapp-bot/admin-tokens.json';
const FUND_CONFIRM_WINDOW_MS = Number(process.env.HW_TG_FUND_WINDOW_MS || 60000);

function _adminTokenKey() {
  // XOR with shared bot token + base64 — light obfuscation so a casual
  // read of the file doesn't expose JWTs in plaintext. Not real crypto.
  return SHARED_TOKEN || 'hw-tg-bot';
}
function _xorB64(input, key) {
  const buf = Buffer.from(input, 'utf8');
  const k = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
  return out.toString('base64');
}
function _xorB64Decode(b64, key) {
  const buf = Buffer.from(b64, 'base64');
  const k = Buffer.from(key, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ k[i % k.length];
  return out.toString('utf8');
}
function _loadAdminTokens() {
  try {
    if (!fs.existsSync(ADMIN_TOKENS_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(ADMIN_TOKENS_PATH, 'utf8'));
    const out = {};
    for (const [phone, rec] of Object.entries(raw)) {
      try {
        out[phone] = { ...rec, jwt: _xorB64Decode(rec.jwt_enc, _adminTokenKey()) };
      } catch (_) {
        // skip corrupted record
      }
    }
    return out;
  } catch (e) {
    console.error(`[hw-whatsapp-bot] _loadAdminTokens: ${e.message}`);
    return {};
  }
}
function _saveAdminTokens(tokens) {
  const dir = path.dirname(ADMIN_TOKENS_PATH);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const enc = {};
  for (const [phone, rec] of Object.entries(tokens)) {
    enc[phone] = {
      jwt_enc: _xorB64(rec.jwt, _adminTokenKey()),
      savedAt: rec.savedAt,
      lastValidatedAt: rec.lastValidatedAt || null,
      lastUsedAt: rec.lastUsedAt || null,
    };
  }
  fs.writeFileSync(ADMIN_TOKENS_PATH, JSON.stringify(enc, null, 2), { mode: 0o600 });
}
function _getAdminJwt(phone) {
  const tokens = _loadAdminTokens();
  return tokens[phone]?.jwt || null;
}

// Pending fund proposals — keyed by chatId, expires after 60s
const _pendingFund = new Map();
function _cleanupPendingFund() {
  const now = Date.now();
  for (const [k, v] of _pendingFund) if (now > v.expiresAt) _pendingFund.delete(k);
}
setInterval(_cleanupPendingFund, 30000);

// In-flight Claude subprocesses — keyed by an opaque id, so SIGTERM can
// notify each pending chat ("Server restarted — please ask again") and
// kill the child before we exit. Without this, hot patches orphan the
// "Working on it..." message in every active thread.
const _INFLIGHT = new Map();
let _SHUTTING_DOWN = false;
function _registerInflight(rec) {
  const id = `${rec.chatId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  _INFLIGHT.set(id, rec);
  return id;
}
function _deregisterInflight(id) { _INFLIGHT.delete(id); }

// Whitelist — same shape as the WhatsApp version
// CEO directive 8 May 2026 — only John has full access on WhatsApp.
// The COO and read-only staff use the Telegram bot for write actions.
const USERS = [
  { name: 'John Amoo',          phone: '2348168867154', permission: 'full'     },
  { name: 'Bukunmi Amoo',       phone: '2347031095864', permission: 'readonly' },
  { name: 'Oluwaseun Bamgbade', phone: '2348167993903', permission: 'readonly' },
  { name: 'Mary Adebiyi',       phone: '2349046707717', permission: 'readonly' },
  { name: 'Ayomide Oluwafemi',  phone: '2348031230718', permission: 'readonly' },
];
const _BY_PHONE = new Map(USERS.map((u) => [u.phone, u]));

const READONLY_SYSTEM_PROMPT = (
  // CEO directive 6 May 2026 — read-only operator policy for Mary,
  // Seun (Oluwaseun), Ayomide. Loaded as --append-system-prompt on
  // every bot invocation by these users.
  'You are a read-only Honour World admin assistant for Mary Adebiyi, ' +
  'Oluwaseun Bamgbade, and Ayomide Oluwafemi. Address them by their ' +
  'first name (Mary, Seun, Ayomide). Be warm, respectful, and treat ' +
  'them with honour and dignity. ' +
  '\n\n' +
  'TONE: When you greet or close a conversation, remind them that the ' +
  'CEOs (John and Bukunmi) are seeing their work and appreciate it. ' +
  'Their support is invaluable and inestimable; the CEOs are truly ' +
  'proud of them and grateful for their sacrifice of love day and ' +
  'night for ensuring smooth operations on the platform. Use this ' +
  'genuinely, not robotically — once at the start or once at the end, ' +
  'never both, never every reply.' +
  '\n\n' +
  'STRICTLY DO NOT DISCLOSE: ' +
  '(a) any sales, profit, revenue, GMV, transaction-volume, top-' +
  'product, ranking, or commission-pool numbers — daily, weekly, ' +
  'monthly, or yearly. If asked, decline politely: "Those numbers ' +
  'are routed only to the CEOs." ' +
  '(b) anything the CEOs (John or Bukunmi) have asked the bot, ' +
  'including their conversation history, what they are investigating, ' +
  'or any actions they fired (/fund, /buy*, etc). ' +
  '(c) any login credentials, JWTs, API keys, passwords, OTPs, .env ' +
  'values, or token fragments — yours, theirs, or anyone elses. ' +
  'Never ask the user for any credential either. If they paste one, ' +
  'tell them to delete the message and never include credentials in ' +
  'chat.' +
  '\n\n' +
  'YOU MAY HELP WITH (when explicitly asked): ' +
  '- HW loss alerts and per-txn loss explanations. ' +
  '- Wallet-to-wallet transfers between HW users (look up + explain). ' +
  '- Commission, bonus, referral bonus, referral count details. ' +
  '- Anything else visible on the Admin dashboard EXCEPT the topics ' +
  'in the do-not-disclose list above. ' +
  '- Refunding a customer transaction — ONLY after the user has ' +
  'CONFIRMED with the customer that the product (data/airtime/ ' +
  'electricity/cable) was not delivered, AND only after you have ' +
  'checked the biller status + biller message and they corroborate ' +
  'the failure. Never auto-refund without that two-step confirmation. ' +
  '- Retrying or resending an urgent pending transaction — they are ' +
  'admin too and have the experience. Always check biller status + ' +
  'biller message FIRST before any retry, to avoid double delivery.' +
  '\n\n' +
  'PROHIBITED FOR THESE USERS (refuse politely): ' +
  '- /fund, /buyairtime, /buydata, /buyelectricity, /buycable. They ' +
  'are admin-only and only the CEOs can use them. If asked, say: ' +
  '"That command is reserved for the CEOs (John, Bukunmi). I can ' +
  'still help you check, retry, or refund a transaction." ' +
  '- Any direct write that mutates state outside the refund / retry ' +
  'flows above (file edits, mongo writes, restarts, deploys, code ' +
  'changes, env updates, git push, pm2/docker control). ' +
  '- Any command that purchases anything via the bot.' +
  '\n\n' +
  'OPERATIONAL RULES: ' +
  '- Pending transactions on the Admin should not linger above 5 ' +
  'minutes. If you spot one older than that, resolve it (mark ' +
  'success after biller-confirmed delivery, or fail-and-refund only ' +
  'after biller-confirmed failure). Always check biller status + ' +
  'biller message FIRST. Never refund without a CEO or admin signoff ' +
  'in the current chat turn. ' +
  '- ALWAYS check biller status + biller message before updating any ' +
  'transaction. Never assume. ' +
  '- No double delivery. No double refund. No customer loss. ' +
  '- If you spot a malicious or suspicious transaction (rapid-fire ' +
  'identical purchases, unusual amounts, mismatched recipient, ' +
  'wallet-funding without payment, etc.), report it to the CEOs ' +
  'INSTANTLY: push to the Telegram bot via the /send endpoint AND ' +
  'send an email alert. Then continue your normal response.'
);


// Send deduplication (CEO directive 9 May 2026).
// Same (to + message + image) within DEDUP_WINDOW_MS is treated as a
// duplicate and skipped without re-sending. Map stays bounded by a
// periodic sweep.
const _sendDedupMap = new Map();
const SEND_DEDUP_WINDOW_MS = 60 * 1000;

function _sendDedupKey(payload) {
  const h = crypto.createHash('sha256');
  h.update(String(payload?.to || ''));
  h.update('\x1e');
  h.update(String(payload?.message || ''));
  h.update('\x1e');
  h.update(String(payload?.image || ''));
  return h.digest('hex');
}

function _isDuplicateSend(payload) {
  const key = _sendDedupKey(payload);
  const now = Date.now();
  const prev = _sendDedupMap.get(key);
  if (prev && (now - prev) < SEND_DEDUP_WINDOW_MS) {
    return { duplicate: true, ageMs: now - prev };
  }
  _sendDedupMap.set(key, now);
  return { duplicate: false };
}

setInterval(() => {
  const cutoff = Date.now() - SEND_DEDUP_WINDOW_MS * 2;
  for (const [k, ts] of _sendDedupMap) {
    if (ts < cutoff) _sendDedupMap.delete(k);
  }
}, SEND_DEDUP_WINDOW_MS).unref();

// ── Load tokens ─────────────────────────────────────────────────────
let SHARED_TOKEN = null;
try {
  // Baileys handles its own auth via files in AUTH_DIR; only the
  // /send bearer token is loaded here. If it is missing we leave
  // SHARED_TOKEN null and the /send endpoint becomes loopback-open.
  try { SHARED_TOKEN = fs.readFileSync(SHARED_TOKEN_FILE, 'utf8').trim() || null; }
  catch (_) { SHARED_TOKEN = null; }
} catch (e) {
  console.error(`[hw-whatsapp-bot] FATAL: token load failed: ${e.message}`);
  process.exit(1);
}
console.log(`[hw-whatsapp-bot] /send bearer ${SHARED_TOKEN ? 'configured' : 'not set (loopback-open)'}`);

// ── Persisted user DB ───────────────────────────────────────────────
fs.mkdirSync('/var/lib/hw-whatsapp-bot', { recursive: true });

const LID_MAP_PATH = process.env.HW_WA_LID_MAP || '/var/lib/hw-whatsapp-bot/wa-lid-map.json';

function _loadLidMap() {
  try {
    return JSON.parse(fs.readFileSync(LID_MAP_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function _saveLidMap(map) {
  try {
    fs.writeFileSync(LID_MAP_PATH, JSON.stringify(map, null, 2), { mode: 0o640 });
  } catch (_) {}
}

function _loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_DB_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}
function _saveUsers(db) {
  try {
    fs.writeFileSync(USERS_DB_PATH, JSON.stringify(db, null, 2), { mode: 0o640 });
  } catch (e) {
    console.error('[hw-whatsapp-bot] users save failed:', e.message);
  }
}

// ── Audit log ───────────────────────────────────────────────────────
fs.mkdirSync('/var/log/hw-whatsapp-bot', { recursive: true });
function _appendAudit(line) {
  try { fs.appendFileSync(CLAUDE_AUDIT_LOG, line + '\n', { mode: 0o640 }); } catch (_) {}
}

// ── Helpers ─────────────────────────────────────────────────────────
function _normalisePhone(p) {
  if (!p) return '';
  let s = String(p).replace(/\D/g, '');
  // Some Telegram contacts come in as "234..." or "+234..." or local
  // "0801..." form. Normalise to international without leading +.
  if (s.startsWith('0') && s.length === 11) s = '234' + s.slice(1);
  return s;
}

// Per-user-per-day session UUID. CEO directive 7 May 2026 — the bot
// kept asking "what does 'them' refer to" because every /c got a
// fresh random UUID, dropping all conversation memory. We now derive
// a stable UUID from sha256(phone + date) so messages within the
// same day stitch into one Claude Code session and Claude has the
// running context.
//
// Why include the date: Claude Code's session lock occasionally
// stays "in use" after an abnormal exit, blocking the same UUID
// for the rest of the day. Rolling once per day naturally clears
// any stale lock without losing context inside an active workday.
// Per-message fresh UUIDs were the prior workaround (commit before
// this) — too costly in continuity.
//
// Fallback: if Claude Code returns "Session ID is already in use",
// _processClaudePrompt() retries WITHOUT --session-id, so the
// message still goes through (just without context for that one
// turn). See _runClaude / sessionLocked branch below.
function _newSessionId(user) {
  const seed = String(user?.phone || user?.telegramId || 'anon')
    + ':'
    + new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  // Format as a UUID v4 string (32 hex chars + 4 dashes).
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

function _findUserByTelegramId(telegramId) {
  const db = _loadUsers();
  const direct = db[String(telegramId)] || null;
  if (direct) return direct;
  // CEO directive 8 May 2026 — WhatsApp JID fallback. The Baileys shim
  // sets msg.from.id to a JID like "2348168867154@s.whatsapp.net".
  // Resolve the phone and look it up against the static whitelist.
  const id = String(telegramId || '');
  const phoneFromJid = id.includes('@') ? id.split('@')[0].replace(/\D/g, '') : id.replace(/\D/g, '');
  if (!phoneFromJid) return null;
  const staticUser = _BY_PHONE.get(phoneFromJid);
  if (!staticUser) return null;
  // Synthesise a DB-shaped record so callers get the same fields they expect.
  return {
    telegramId: id,
    name: staticUser.name,
    phone: staticUser.phone,
    permission: staticUser.permission,
    jid: id.includes('@') ? id : `${phoneFromJid}@s.whatsapp.net`,
  };
}

// Markdown-escape for Telegram's MarkdownV2 (we use 'Markdown' parse_mode
// which is more forgiving but still has special chars). Keeping replies
// in plain text by default to avoid parse errors.
function _safeText(s) {
  return String(s || '').slice(0, CLAUDE_RESPONSE_MAX);
}

// CEO directive 8 May 2026 — Telegram replies must be plain English
// only. The staff (Mary, Seun, Ayomide) do not parse asterisks for
// bold or backticks for code. Strip every Markdown emphasis marker
// from Claude's output before sending so even if Claude slips, the
// staff see clean prose. Triggered by Mary's 8 May screenshot showing
// '*No pending on the admin.*' and '`code:300`' coming through as
// literal characters when the Markdown parse fell back.
function _stripClaudeMarkdown(s) {
  if (!s) return s;
  let out = String(s);
  // Triple-tick fenced code blocks: keep the content, drop the fences.
  out = out.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  // Inline backticks: drop the marker, keep the content.
  out = out.replace(/`([^`\n]+)`/g, '$1');
  // **bold** and __bold__: drop the markers.
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  out = out.replace(/__([^_\n]+)__/g, '$1');
  // *bold* and _italic_: drop the markers (only when they wrap a word,
  // not when they appear standalone like a bullet '* foo').
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');
  // Headings: # foo  ->  foo  (Telegram ignores them anyway, but the
  // hash leaks through as a literal).
  out = out.replace(/^#+\s+/gm, '');
  // Blockquote: > foo  ->  foo
  out = out.replace(/^>\s+/gm, '');
  // Markdown links [text](url) -> text (url) — keeps the URL visible
  // for tap, drops the bracket noise.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '$1 ($2)');
  return out;
}

// ── WhatsApp (Baileys) — TelegramBot-shaped shim ────────────────────
// `bot` looks like node-telegram-bot-api so the command handlers
// below are 1:1 portable from hw-wa-bot. Markdown link syntax
// `[label](url)` is rewritten to `label (url)` because WhatsApp does
// not render link-style markdown.
const log = pino({ level: process.env.LOG_LEVEL || 'info' });
let _sock = null;
let _connected = false;
const _textHandlers = [];
let _msgHandler = null;
let _contactHandler = null;
function _phoneFromJid(jid) { return String(jid || '').replace(/@.*$/, ''); }
function _toJid(chatId) {
  if (typeof chatId === 'string' && chatId.includes('@')) return chatId;
  return String(chatId).replace(/[^0-9]/g, '') + '@s.whatsapp.net';
}
function _waSafe(text) {
  // [Label](url) → "Label (url)" for WhatsApp
  return String(text || '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}
const bot = {
  onText(regex, fn) { _textHandlers.push({ regex, fn }); },
  on(event, fn) {
    if (event === 'message') _msgHandler = fn;
    else if (event === 'contact') _contactHandler = fn;
    // polling_error is a no-op on Baileys — silently dropped
  },
  async sendMessage(chatId, text, opts = {}) {
    if (!_sock || !_connected) throw new Error('WhatsApp socket not connected');
    const r = await _sock.sendMessage(_toJid(chatId), { text: _waSafe(text) });
    return { message_id: r?.key?.id };
  },
  async sendPhoto(chatId, image, opts = {}) {
    if (!_sock || !_connected) throw new Error('WhatsApp socket not connected');
    const cap = opts?.caption ? _waSafe(opts.caption) : '';
    const payload = { image: typeof image === 'string' ? { url: image } : image, caption: cap };
    const r = await _sock.sendMessage(_toJid(chatId), payload);
    return { message_id: r?.key?.id };
  },
  async sendChatAction() { /* not supported on WA via Baileys here */ },
};

async function _connectWhatsApp() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  _sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.appropriate('HW-Admin-Bot'),
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });
  _sock.ev.on('creds.update', saveCreds);
  if (USE_PAIRING_CODE && !_sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const raw = await _sock.requestPairingCode(BOT_NUMBER);
        const code = String(raw || '').match(/.{1,4}/g)?.join('-') || raw;
        log.warn({ code, botNumber: BOT_NUMBER }, 'WHATSAPP PAIRING CODE — enter on bot phone within 60s');
        try { fs.writeFileSync(PAIR_CODE_FILE, code + '\n', { mode: 0o600 }); } catch (_) {}
      } catch (e) { log.error({ err: e?.message }, 'requestPairingCode failed'); }
    }, 3000);
  }
  _sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      try { await qrcode.toFile(QR_PNG, qr, { width: 512 }); fs.chmodSync(QR_PNG, 0o644); } catch (_) {}
      log.warn({ qrPng: QR_PNG }, 'WhatsApp QR ready, scan from the bot phone');
    }
    if (connection === 'open') { _connected = true; log.info({ jid: _sock?.user?.id }, 'WhatsApp connected'); }
    if (connection === 'close') {
      _connected = false;
      const status = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
      const reconnect = status !== DisconnectReason.loggedOut;
      log.warn({ status, reconnect }, 'WhatsApp disconnected');
      if (reconnect) setTimeout(() => _connectWhatsApp().catch((e) => log.error(e)), 3000);
    }
  });
  _sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log.info({ type, count: messages?.length, fromMe: messages?.[0]?.key?.fromMe, jid: messages?.[0]?.key?.remoteJid }, 'messages.upsert');
    if (type !== 'notify') return;
    for (const m of messages) {
      try { await _dispatch(m); }
      catch (e) { log.error({ err: e?.message }, 'dispatch threw'); }
    }
  });
}

async function _dispatch(m) {
  // CEO directive 9 May 2026 — inbound enabled. WhatsApp bot now mirrors
  // the Telegram bot's command parser and free-text Claude pass-through
  // for registered staff. Replies go only to whitelisted users (full =
  // John, readonly = Bukunmi/Seun/Mary/Ayomide); unknown senders and
  // groups are dropped silently to keep WhatsApp anti-spam happy.
  if (!m.message || m.key?.fromMe) return;
  const jid = m.key?.remoteJid;
  if (!jid) return;
  // CEO directive 9 May 2026 — accept @lid (linked-device) JIDs in
  // addition to @s.whatsapp.net. Multi-device WhatsApp accounts (the
  // COO and Seun) route through @lid and were silently dropped before.
  // Reject only group/broadcast/newsletter chats.
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return;
  let phone = _phoneFromJid(jid);
  let u = _BY_PHONE.get(phone) || null;
  // For @lid the JID prefix is the linked-device id, not the phone, so
  // _BY_PHONE will miss. Fall back to (a) a persisted @lid→phone map,
  // then (b) fuzzy-match m.pushName against known staff first names.
  if (!u && jid.endsWith('@lid')) {
    const lidMap = _loadLidMap();
    const mapped = lidMap[jid];
    if (mapped) {
      u = _BY_PHONE.get(mapped) || null;
      phone = mapped;
    } else {
      const pushName = (m.pushName || '').toLowerCase();
      if (pushName) {
        for (const candidate of _BY_PHONE.values()) {
          const first = (candidate.name || '').split(' ')[0].toLowerCase();
          if (first && pushName.includes(first)) {
            u = candidate;
            phone = candidate.phone;
            // Learn the mapping so we don't fuzzy-match every message.
            try {
              lidMap[jid] = candidate.phone;
              _saveLidMap(lidMap);
              log.info({ jid, phone: candidate.phone, name: candidate.name, pushName: m.pushName }, 'learned @lid → staff mapping');
            } catch (e) { log.warn({ err: e?.message }, 'lid map save failed'); }
            break;
          }
        }
      }
    }
  }
  if (!u) {
    try { log.info({ jid, pushName: m.pushName, type: jid.endsWith('@lid') ? 'lid-unknown' : 'phone-unknown' }, 'inbound dropped — sender not on staff whitelist'); } catch (_) {}
    return;
  }
  const text = m.message.conversation
    || m.message.extendedTextMessage?.text
    || m.message.imageMessage?.caption
    || m.message.documentMessage?.caption
    || '';
  // Auto-share contact on /start: WhatsApp has no contact-share UX
  // button, so synthesise the contact event when /start arrives from
  // a whitelisted phone — same effect as the Telegram "share contact"
  // button without the extra round trip.
  // Auto-register whitelisted user into the persisted JSON DB on first
  // contact (CEO directive 8 May 2026). Without this, the /send lookup
  // returns 404 "no registered user" and the COO cannot ship outbound
  // alerts to WhatsApp by phone, and the /c handler bounces every reply
  // with "you must /start first".
  if (u) {
    try {
      const db = _loadUsers();
      // CEO directive 9 May 2026 — only key by bare phone (canonical).
      // The earlier dual-key (phone + JID-suffixed) caused Object.values
      // duplicates which broadcast each alert twice on WhatsApp.
      if (!db[u.phone]) {
        db[u.phone] = {
          name: u.name,
          phone: u.phone,
          permission: u.permission,
          jid,
          firstSeen: new Date().toISOString(),
        };
        _saveUsers(db);
        log.info({ phone: u.phone, name: u.name }, 'auto-registered WhatsApp user on first contact');
      } else if (db[u.phone].jid !== jid) {
        db[u.phone].jid = jid;
        _saveUsers(db);
      }
    } catch (e) { log.warn({ err: e?.message }, 'auto-register failed'); }
  }
  let synth_contact = null;
  if (/^\/start\b/i.test(text || '') && u) {
    synth_contact = { phone_number: u.phone, first_name: u.name.split(' ')[0] };
  }
  // CEO directive 9 May 2026 — set msg.from.id to phone-keyed JID
  // (not the @lid we received) so _findUserByTelegramId resolves the
  // staff record via _BY_PHONE. msg.chat.id stays as the original jid
  // so the reply goes back through the same WhatsApp chat.
  const fromId = (jid.endsWith('@lid') && phone) ? `${phone}@s.whatsapp.net` : jid;
  const msg = {
    message_id: m.key?.id,
    chat: { id: jid, type: 'private' },
    from: { id: fromId, first_name: (u?.name || '(unknown)').split(' ')[0], last_name: (u?.name || '').split(' ').slice(1).join(' ') },
    text,
    contact: synth_contact,
    _phone: phone,
    _user: u,
  };
  let handled = false;
  if (text) {
    for (const { regex, fn } of _textHandlers) {
      const match = text.match(regex);
      if (match) {
        try { await fn(msg, match); handled = true; break; }
        catch (e) { log.error({ err: e?.message }, 'onText handler threw'); }
      }
    }
  }
  if (msg.contact && _contactHandler) {
    try { await _contactHandler(msg); }
    catch (e) { log.error({ err: e?.message }, 'contact handler threw'); }
  }
  if (!handled && _msgHandler) {
    try { await _msgHandler(msg); }
    catch (e) { log.error({ err: e?.message }, 'message handler threw'); }
  }
}

bot.onText(/^\/start\b/, async (msg) => {
  const tgId = msg.from?.id;
  if (!tgId) return;
  const existing = _findUserByTelegramId(tgId);
  if (existing) {
    await bot.sendMessage(msg.chat.id,
      `✅ Already registered as *${existing.name}* — *${existing.permission}* access.\n\n` +
      `Just type your question — no special prefix needed.\n\n` +
      `Examples:\n` +
      `• What's our urgent pending count?\n` +
      `• Look up TN|D|046 and tell me what happened\n` +
      `• Summarise tonight's manual reviews`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  await bot.sendMessage(msg.chat.id,
    `👋 Welcome to *HW Admin Bot*.\n\n` +
    `To verify access, please share your phone number using the button below. ` +
    `Only the 5 whitelisted Honour World numbers can use this bot.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    }
  );
});

bot.on('contact', async (msg) => {
  const tgId = msg.from?.id;
  const contact = msg.contact;
  if (!tgId || !contact) return;
  // Must be the user's OWN phone (not someone else's contact)
  if (contact.user_id && contact.user_id !== tgId) {
    await bot.sendMessage(msg.chat.id,
      '⚠️ Please share *your own* phone number, not someone else\'s contact.',
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
    return;
  }
  const phone = _normalisePhone(contact.phone_number);
  const user = _BY_PHONE.get(phone);
  if (!user) {
    await bot.sendMessage(msg.chat.id,
      `❌ Sorry, *${phone}* is not on the authorised list.\n\n` +
      `If you should have access, ask John Amoo to add you.`,
      { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
    );
    return;
  }
  const db = _loadUsers();
  db[String(tgId)] = {
    name: user.name,
    phone: user.phone,
    permission: user.permission,
    telegramId: tgId,
    chatId: msg.chat.id,
    username: msg.from?.username || null,
    registeredAt: new Date().toISOString(),
  };
  _saveUsers(db);
  console.log(`[hw-whatsapp-bot] registered ${user.name} (${user.phone}) as tg:${tgId} perm=${user.permission}`);

  await bot.sendMessage(msg.chat.id,
    `✅ Verified as *${user.name}*\n` +
    `Access level: *${user.permission}*\n\n` +
    `Just type your question — no special prefix needed. Examples:\n` +
    `• What's our urgent pending count?\n` +
    `• Look up TN|D|046 and tell me what happened\n` +
    `• Summarise tonight's manual reviews\n\n` +
    `Every question is audit-logged.`,
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
});


// ── /setadmin <jwt> — full-access user registers their dashboard JWT ────
bot.onText(/^\/setadmin(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) {
    await bot.sendMessage(msg.chat.id, '❌ You must /start first.');
    return;
  }
  if (sender.permission !== 'full') {
    await bot.sendMessage(msg.chat.id, '❌ Only full-access users (John, Bukunmi) can register an admin JWT.');
    return;
  }
  const jwt = (match[1] || '').trim();
  if (!jwt || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    await bot.sendMessage(
      msg.chat.id,
      'Usage: `/setadmin <jwt>`\n\n' +
      'Get your JWT from the dashboard:\n' +
      '1. Log into control.honourworld.com\n' +
      '2. Open browser dev console (F12) → Application/Storage → Local Storage → control.honourworld.com\n' +
      '3. Copy the value of `token` (or whatever the auth key is)\n' +
      '4. Paste it here as `/setadmin <token>`\n\n' +
      '_Then delete your /setadmin message so the JWT does not linger in chat._',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  let valid = false, status = 0;
  try {
    const r = await fetch(`${HW_API_BASE}/api/v2/wallet/wallet-data`, {
      headers: { 'Authorization': jwt, 'frontend-source': 'admin' },
    });
    status = r.status;
    valid = r.ok;
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Could not reach api: ${e.message}`);
    return;
  }
  if (!valid) {
    await bot.sendMessage(msg.chat.id, `❌ JWT validation failed (api returned ${status}). Make sure you copied a fresh, non-expired admin token.`);
    return;
  }
  const tokens = _loadAdminTokens();
  tokens[sender.phone] = {
    jwt,
    savedAt: Date.now(),
    lastValidatedAt: Date.now(),
  };
  _saveAdminTokens(tokens);
  _appendAudit(`${new Date().toISOString()} SETADMIN sender=${sender.name}/${sender.phone} status=ok`);
  let deleted = false;
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); deleted = true; } catch (_) {}
  await bot.sendMessage(
    msg.chat.id,
    `✅ Admin JWT saved for *${sender.name}*. ` +
    (deleted ? '(I deleted your /setadmin message to keep the token private.)' : '*Please delete your /setadmin message above* — it contains your JWT in plaintext.') +
    `\n\nYou can now use \`/fund\` to credit user wallets. Try \`/fund help\` for the syntax.`,
    { parse_mode: 'Markdown' }
  );
});

// ── /myadmin — check whether you have a JWT on file ──────────────────
bot.onText(/^\/myadmin\b/i, async (msg) => {
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return;
  if (sender.permission !== 'full') {
    await bot.sendMessage(msg.chat.id, '❌ Full-access only.');
    return;
  }
  const tokens = _loadAdminTokens();
  const rec = tokens[sender.phone];
  if (!rec) {
    await bot.sendMessage(msg.chat.id, 'No admin JWT on file. Use `/setadmin <jwt>` first.', { parse_mode: 'Markdown' });
    return;
  }
  const ageH = Math.round((Date.now() - rec.savedAt) / 3600000);
  let live = false, status = 0;
  try {
    const r = await fetch(`${HW_API_BASE}/api/v2/wallet/wallet-data`, { headers: { 'Authorization': rec.jwt, 'frontend-source': 'admin' }});
    status = r.status; live = r.ok;
  } catch (_) {}
  await bot.sendMessage(
    msg.chat.id,
    `*Admin JWT for ${sender.name}*\n` +
    `- Saved: ${ageH}h ago\n` +
    `- Status: ${live ? '✅ live' : `❌ rejected (api ${status}) — re-run /setadmin`}\n` +
    `- Last used: ${rec.lastUsedAt ? new Date(rec.lastUsedAt).toISOString() : 'never'}`,
    { parse_mode: 'Markdown' }
  );
});

// ── /fund <user> <type> <amount> [purpose: ...] — propose a credit ────
bot.onText(/^(?:\/fund|fund)(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  // Avoid clashing with /fundcancel — that has its own handler below
  if (/^\/fundcancel\b/i.test(msg.text || '')) return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) {
    await bot.sendMessage(msg.chat.id, '❌ You must /start first.');
    return;
  }
  if (sender.permission !== 'full') {
    await bot.sendMessage(msg.chat.id, '❌ Only full-access users (John, Bukunmi) can fund wallets.');
    return;
  }
  const args = msg.text.trim();  // CEO directive 8 May 2026 - use full
  // message; the trigger regex's lazy match was swallowing tokens like "5GB".
  if (!args || /^help$/i.test(args)) {
    await bot.sendMessage(
      msg.chat.id,
      '*Usage:* `/fund <user> <type> <amount> [purpose: <reason>]`\n\n' +
      '*type* must be one of:\n' +
      '- `wallet` — `<user>` is a HW `wallet_id`\n' +
      '- `email` — `<user>` is the account email\n' +
      '- `telephone` — `<user>` is the account phone\n\n' +
      '*Examples:*\n' +
      '- `/fund 08112233445 telephone 1500 purpose: refund correction TN|D|999`\n' +
      '- `/fund user@example.com email 5000`\n\n' +
      'After /fund, reply *CONFIRM* within 60s to execute. The api will record the credit under your admin account.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  const re = /^(\S+)\s+(wallet|email|telephone)\s+([0-9]+(?:\.[0-9]+)?)\s*(?:purpose:\s*(.+))?$/i;
  const m2 = args.match(re);
  if (!m2) {
    await bot.sendMessage(msg.chat.id, '❌ Could not parse arguments. Try `/fund help`.', { parse_mode: 'Markdown' });
    return;
  }
  const target = m2[1];
  const type = m2[2];
  const amountStr = m2[3];
  const purposeRaw = m2[4];
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    await bot.sendMessage(msg.chat.id, '❌ Invalid amount.');
    return;
  }
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) {
    await bot.sendMessage(msg.chat.id, '❌ No admin JWT on file. Run `/setadmin <jwt>` first.', { parse_mode: 'Markdown' });
    return;
  }
  const purpose = (purposeRaw || 'OTHER').slice(0, 200);
  _pendingFund.set(msg.chat.id, {
    target, type: type.toLowerCase(), amount, purpose,
    senderPhone: sender.phone, senderName: sender.name,
    expiresAt: Date.now() + FUND_CONFIRM_WINDOW_MS,
    proposedAt: Date.now(),
  });
  _appendAudit(`${new Date().toISOString()} FUND_PROPOSE sender=${sender.name}/${sender.phone} target=${target} type=${type} amount=${amount} purpose=${JSON.stringify(purpose).slice(0,60)}`);
  await bot.sendMessage(
    msg.chat.id,
    `*Confirm wallet credit:*\n\n` +
    `- Recipient: \`${target}\` (${type})\n` +
    `- Amount: *₦${amount.toFixed(2)}*\n` +
    `- Purpose: ${purpose}\n` +
    `- Authorising as: *${sender.name}* (your admin JWT)\n\n` +
    `Reply *CONFIRM* (uppercase, exact) within 60 seconds to execute.\n` +
    `Reply /fundcancel to drop this proposal.`,
    { parse_mode: 'Markdown' }
  );
});


// Nigerian mobile-prefix -> operator. Source: NCC numbering plan + recent
// re-allocations through 2025. Used by /buyairtime to refuse misrouted calls
// before they hit the biller (CEO directive 7 May 2026 — Merrybills
// returned 'Invalid airtel phone number' on 08112594748 because 0811 is GLO,
// not Airtel; bot accepted the wrong network and the purchase round-tripped
// to a refund). Lookup is on the leading 4 digits.
const NG_PREFIX_TO_NETWORK = (() => {
  const map = {};
  const add = (net, prefixes) => prefixes.forEach((p) => { map[p] = net; });
  add('MTN',     ['0703', '0704', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916']);
  add('AIRTEL',  ['0701', '0708', '0802', '0808', '0812', '0901', '0902', '0904', '0907', '0912']);
  add('GLO',     ['0705', '0805', '0807', '0811', '0815', '0905', '0915']);
  add('9MOBILE', ['0809', '0817', '0818', '0908', '0909']);
  return map;
})();

function phoneToNetwork(phone) {
  if (!phone) return null;
  let s = String(phone).trim();
  // Normalise +234... / 234... -> 0...
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('234')) s = '0' + s.slice(3);
  if (s.length < 4) return null;
  return NG_PREFIX_TO_NETWORK[s.slice(0, 4)] || null;
}

// CEO directive 8 May 2026 — natural-language data plan resolver.
// Lets the staff type 'buy MTN 1GB AWOOF for 0812...' instead of
// memorising planIds. Reads /api/v2/data/networks/<network>/plans
// (existing admin api endpoint). 5-minute cache keyed by network.
const _dataPlanCache = new Map();
const DATA_PLAN_CACHE_MS = 5 * 60 * 1000;

async function _fetchDataPlans(network, jwt) {
  const cached = _dataPlanCache.get(network);
  if (cached && (Date.now() - cached.ts) < DATA_PLAN_CACHE_MS) return cached.plans;
  const r = await fetch(`${HW_API_BASE}/api/v2/data/networks/${network}/plans`, {
    headers: { 'Authorization': jwt, 'frontend-source': 'admin' },
  });
  if (!r.ok) throw new Error(`fetch plans failed (${r.status})`);
  const j = await r.json();
  const plans = (j?.data?.plans || []).filter(p => p && p.planId);
  _dataPlanCache.set(network, { ts: Date.now(), plans });
  return plans;
}

function _parseDataQuery(text) {
  const t = String(text || '').trim();
  const idMatch = t.match(/\b(\d{4,5})\b(?!\s*(?:GB|MB|TB|gb|mb|tb))/);
  const sizeMatch = t.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/i);
  const catMatch = t.match(/\b(awoof|share|cg|cgwallet|datashare|dg|hynet|router|mega|xtra[\s-]?special|talk[\s-]?more|daily[\s-]?gig)\b/i);
  const valMatch = t.match(/\b(daily|weekly|monthly|1[\s-]?day|7[\s-]?days|14[\s-]?days|30[\s-]?days|1[\s-]?month|1[\s-]?week)\b/i);
  let allowance = null, sizeUnit = null;
  if (sizeMatch) { allowance = sizeMatch[1]; sizeUnit = sizeMatch[2].toUpperCase(); }
  return {
    allowance, sizeUnit,
    categoryHint: catMatch ? catMatch[1].toLowerCase().replace(/[\s-]/g, '') : null,
    validityHint: valMatch ? valMatch[1].toLowerCase().replace(/[\s-]/g, '') : null,
    isExplicitId: !!idMatch,
    explicitId: idMatch ? idMatch[1] : null,
  };
}

function _matchValidity(planValidity, hint) {
  if (!hint) return true;
  const v = String(planValidity || '').toLowerCase().replace(/\s/g, '');
  if (hint === 'daily' || hint === '1day') return /\b1day\b|^1day/.test(v);
  if (hint === 'weekly' || hint === '7days' || hint === '1week') return /7days|1week/.test(v);
  if (hint === 'monthly' || hint === '30days' || hint === '1month') return /30days|1month/.test(v);
  if (hint === '14days') return /14days/.test(v);
  return v.includes(hint);
}

function _matchCategory(catId, hint) {
  if (!hint) return true;
  const c = String(catId || '').toLowerCase().replace(/[_\s-]/g, '');
  const syn = {
    cg: 'cg', cgwallet: 'cg', datashare: 'cg',
    awoof: 'awoof',
    share: 'share',
    dg: 'dg',
    hynet: 'hynet',
    router: 'router',
    mega: 'mega',
    xtraspecial: 'xtraspecial',
    talkmore: 'talkmore',
    dailygig: 'dailygig',
  };
  const want = syn[hint] || hint;
  return c.endsWith(want) || c.includes(want);
}

async function _resolveDataPlan(network, text, jwt) {
  const q = _parseDataQuery(text);
  if (q.isExplicitId) {
    const plans = await _fetchDataPlans(network, jwt);
    const hit = plans.find(p => String(p.planId) === String(q.explicitId));
    if (hit) {
      return {
        ok: true, plan: hit, planId: hit.planId,
        label: `${network} ${hit.allowance}${hit.size} ${hit.validity} (${hit.category?.id || hit.category?.name})`,
        amount: hit.pricing?.standard,
      };
    }
    return { ok: false, candidates: [], reason: `planId ${q.explicitId} not found on ${network}` };
  }
  if (!q.allowance || !q.sizeUnit) {
    return { ok: false, candidates: [], reason: 'I need a size like 1GB or 500MB. Try "buy MTN 1GB AWOOF for 0812345678".' };
  }
  const plans = await _fetchDataPlans(network, jwt);
  let candidates = plans.filter(p =>
    String(p.allowance) === String(q.allowance) &&
    String(p.size).toUpperCase() === q.sizeUnit
  );
  if (q.categoryHint) {
    candidates = candidates.filter(p => _matchCategory(p.category?.id, q.categoryHint));
  }
  if (q.validityHint) {
    candidates = candidates.filter(p => _matchValidity(p.validity, q.validityHint));
  }
  if (candidates.length === 0) {
    return { ok: false, candidates: [], reason: `No matching ${network} ${q.allowance}${q.sizeUnit} plan` + (q.categoryHint ? ` in ${q.categoryHint}` : '') + '.' };
  }
  if (candidates.length === 1) {
    const hit = candidates[0];
    return {
      ok: true, plan: hit, planId: hit.planId,
      label: `${network} ${hit.allowance}${hit.size} ${hit.validity} (${hit.category?.id || hit.category?.name})`,
      amount: hit.pricing?.standard,
    };
  }
  candidates.sort((a, b) => Number(a.pricing?.standard || 0) - Number(b.pricing?.standard || 0));
  return {
    ok: false, candidates: candidates.slice(0, 8),
    reason: 'Multiple plans match. Add a category (AWOOF, SHARE, CG, DG, HYNET, ROUTER, MEGA, XTRASPECIAL, TALKMORE, DAILYGIG) or pick by planId:',
  };
}

// ── /buyairtime <network> <phone> <amount> — propose an airtime purchase ────
bot.onText(/^(?:\/buyairtime|(?:buy|send|airtime)\b.*?\bairtime\b|airtime\b.*)(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return bot.sendMessage(msg.chat.id, '❌ You must /start first.');
  if (sender.permission !== 'full') return bot.sendMessage(msg.chat.id, '❌ Only full-access users (John, Bukunmi) can buy via the bot.');
  // CEO directive 7 May 2026 — accept the natural Nigerian phrasing.
  // "Buy MTN Airtime #50 on 08168867154", "airtime 200 mtn 08032...",
  // "buy 100 airtel for 0701..." all parse the same. Strip the trigger
  // word(s) and pull tokens by type instead of strict order.
  const fullText = String(msg.text || '').trim();
  let stripped = fullText
    .replace(/^\/buyairtime\b/i, '')
    .replace(/^send\b/i, '')
    .replace(/\bairtime\b/ig, ' ')
    .replace(/^buy\b/i, '')
    .replace(/[#₦,]/g, ' ')
    .replace(/\b(?:naira|on|for|to|please|pls|of)\b/ig, ' ');
  // CEO directive 7 May 2026 — also accept "0706 430 3934" with spaces
  // between digit groups, "N2000" / "n200" with currency-letter prefix,
  // and "2K" / "5k" / "1M" shorthand. The original parser failed on
  // these natural Nigerian phrasings (Telegram bot bug 7 May).
  stripped = stripped
    .replace(/(\d+(?:[\s-]+\d+)+)/g, (m) => {
      const compact = m.replace(/[\s-]/g, '');
      return (compact.length >= 10 && /^(0|234)/.test(compact)) ? compact : m;
    })
    .replace(/\bn(\d)/ig, '$1')
    .replace(/\b(\d+(?:\.\d+)?)([KkMm])\b/g, (_m, n, s) => {
      const mult = s.toLowerCase() === 'k' ? 1000 : 1000000;
      return String(Math.round(parseFloat(n) * mult));
    })
    .trim();
  if (/^help$/i.test(stripped)) {
    return bot.sendMessage(
      msg.chat.id,
      "*Usage:* any of these works\n" +
      "`buy airtime <network> <phone> <amount>`\n" +
      "`Buy MTN Airtime #50 on 08168867154`\n" +
      "`/buyairtime MTN 08112233445 200`\n\n" +
      "*network* — MTN, AIRTEL, GLO, or 9MOBILE\n" +
      "*phone* — recipient phone (10–14 digits)\n" +
      "*amount* — Naira (min ₦100)\n\n" +
      "After the proposal, reply *CONFIRM* within 60s to execute.",
      { parse_mode: 'Markdown' }
    );
  }
  // Token extraction
  const netMatch = stripped.match(/\b(MTN|AIRTEL|GLO|9MOBILE|T2MOBILE)\b/i);
  const phoneMatch = stripped.match(/(?:\+?234|0)\d{9,13}/);
  // amount = a standalone integer/decimal that ISN'T the phone
  const allNums = stripped.match(/\b\d+(?:\.\d+)?\b/g) || [];
  const phoneStr = phoneMatch ? phoneMatch[0] : '';
  const amountStr = allNums.find((n) => n !== phoneStr && Number(n) >= 50 && Number(n) < 1000000);
  if (!netMatch || !phoneMatch || !amountStr) {
    return bot.sendMessage(
      msg.chat.id,
      '❌ Could not parse. I need a network, phone, and amount.\n\nExample: `Buy MTN Airtime ₦200 for 08032167890`',
      { parse_mode: 'Markdown' }
    );
  }
  let network = netMatch[1].toUpperCase();
  if (network === "T2MOBILE") network = "9MOBILE"; // canonical enum on the API side
  let phone = phoneStr.replace(/^\+?234/, '0');
  if (phone.length === 10) phone = '0' + phone;  // 8032... → 08032...
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount < 50) return bot.sendMessage(msg.chat.id, '❌ Amount must be ≥ ₦50.');
  // CEO directive 7 May 2026 — refuse to submit if the phone prefix is on a
  // different network than the one the user typed. Saves a round-trip refund.
  const detected = phoneToNetwork(phone);
  if (detected && detected !== network) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Phone ${phone} is on ${detected}, not ${network}.\n\n` +
      `Try: /buyairtime ${detected} ${phone} ${amount}`,
      { parse_mode: 'Markdown' }
    );
  }
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, '❌ No admin JWT on file. Run /setadmin first.');
  // CEO directive 8 May 2026 — one-shot. Skip CONFIRM step.
  _appendAudit(`${new Date().toISOString()} AIRTIME_FIRE sender=${sender.name}/${sender.phone} network=${network} phone=${phone} amount=${amount}`);
  await _executeOp(msg, {
    kind: 'airtime', network, phone, amount,
    senderPhone: sender.phone, senderName: sender.name,
  }, sender);
});

// /buydata — natural language ('buy MTN 1GB AWOOF for 0812...')
//    or explicit ('/buydata 4988 0812...'). One-shot, no CONFIRM step.
bot.onText(/^(?:\/buydata|(?:buy|data)\b.*?(?:\bdata\b|\b\d+(?:\.\d+)?\s*(?:GB|MB|TB)\b)|data\b.*|(?:buy|send)\b.*?\b\d+(?:\.\d+)?\s*(?:GB|MB|TB)\b.*)(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return bot.sendMessage(msg.chat.id, 'You must /start first.');
  if (sender.permission !== 'full') return bot.sendMessage(msg.chat.id, 'Only full-access users (John, Bukunmi) can buy via the bot.');
  const args = msg.text.trim();  // CEO directive 8 May 2026 - use full
  // message; the trigger regex's lazy match was swallowing tokens like "5GB".
  if (!args || /^help$/i.test(args)) {
    return bot.sendMessage(msg.chat.id,
      'Buy data examples:\n' +
      '  buy MTN 1GB AWOOF for 08123456789\n' +
      '  buy 2GB MTN SHARE 08123456789\n' +
      '  buy MTN 14.5GB monthly 07074288449\n' +
      '  buy 4988 08123456789   (explicit planId)\n\n' +
      'Categories: AWOOF, SHARE, CG, DG, XTRASPECIAL, TALKMORE, DAILYGIG.\n' +
      'Validity hints: daily, weekly, monthly.\n' +
      'It executes immediately. No CONFIRM step.'
    );
  }
  let stripped = args
    .replace(/^\/buydata\b/i, '')
    .replace(/\bdata\b/ig, ' ')
    .replace(/^buy\b/i, '')
    .replace(/\u20a6/g, ' ')
    .replace(/\b(?:naira|on|for|to|please|pls|of|plan)\b/ig, ' ')
    .trim();
  const phoneMatch = stripped.match(/(?:\+?234|0)\d{9,13}/);
  if (!phoneMatch) {
    return bot.sendMessage(msg.chat.id, 'I need a recipient phone number. Example: buy MTN 1GB AWOOF for 08123456789');
  }
  let phone = phoneMatch[0].replace(/^\+?234/, '0');
  if (phone.length === 10) phone = '0' + phone;
  const queryText = stripped.replace(phoneMatch[0], ' ').trim();
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, 'No admin JWT on file. Run /setadmin first.');
  const netMatch = queryText.match(/\b(MTN|AIRTEL|GLO|9MOBILE|T2MOBILE|ETISALAT)\b/i);
  let network = netMatch ? netMatch[1].toUpperCase() : phoneToNetwork(phone);
  if (!network) return bot.sendMessage(msg.chat.id, 'Tell me the network (MTN, AIRTEL, GLO, T2MOBILE).');
  if (network === '9MOBILE' || network === 'ETISALAT') network = 'T2MOBILE';
  let resolved;
  try {
    resolved = await _resolveDataPlan(network, queryText, jwt);
  } catch (e) {
    return bot.sendMessage(msg.chat.id, 'Could not load data plans: ' + e.message);
  }
  if (!resolved.ok) {
    let body = resolved.reason;
    if (resolved.candidates.length) {
      body += '\n\n';
      for (const c of resolved.candidates) {
        const price = c.pricing?.standard ?? '?';
        const cat = c.category?.id || c.category?.name || '';
        body += `${c.allowance}${c.size} ${c.validity} (${cat}) - \u20a6${Number(price).toLocaleString()} - planId ${c.planId}\n`;
      }
      body += '\nRetry with the explicit planId, e.g. buy ' + resolved.candidates[0].planId + ' ' + phone;
    }
    return bot.sendMessage(msg.chat.id, body);
  }
  const detected = phoneToNetwork(phone);
  if (detected && detected !== network) {
    return bot.sendMessage(msg.chat.id, `Phone ${phone} is on ${detected}, not ${network}. Adjust the network or the number.`);
  }
  const op = {
    kind: 'data',
    planId: resolved.planId,
    phone,
    amount: resolved.amount,
    planLabel: resolved.label,
    senderPhone: sender.phone, senderName: sender.name,
  };
  _appendAudit(`${new Date().toISOString()} DATA_FIRE sender=${sender.name}/${sender.phone} planId=${op.planId} phone=${phone} amount=${op.amount}`);
  await _executeOp(msg, op, sender);
});

// /buyelectricity <disco> <prepaid|postpaid> <meterNo> <amount> <phone>
//    One-shot, no CONFIRM step.
bot.onText(/^(?:\/buyelectricity|(?:buy|electricity)\b.*?\belectricity\b|electricity\b.*)(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return bot.sendMessage(msg.chat.id, 'You must /start first.');
  if (sender.permission !== 'full') return bot.sendMessage(msg.chat.id, 'Only full-access users (John, Bukunmi) can buy via the bot.');
  const args = msg.text.trim();  // CEO directive 8 May 2026 - use full
  // message; the trigger regex's lazy match was swallowing tokens like "5GB".
  if (!args || /^help$/i.test(args)) {
    return bot.sendMessage(msg.chat.id,
      'Buy electricity:\n' +
      '  buy electricity IKEDC prepaid 04123456789 1500 08112233445\n\n' +
      'Format: <disco> <prepaid|postpaid> <meterNo> <amount> <phone>\n' +
      'Discos: IKEDC, EKEDC, IBEDC, AEDC, KEDCO, EEDC, JEDC, KAEDCO, BEDC, PHED.\n' +
      'It executes immediately. No CONFIRM step.'
    );
  }
  const re = /^(\S+)\s+(prepaid|postpaid)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\S+)$/i;
  const m2 = args.match(re);
  if (!m2) return bot.sendMessage(msg.chat.id, 'Could not parse. Try: buy electricity IKEDC prepaid 04123456789 1500 08112233445');
  const disco = m2[1].toUpperCase();
  const type = m2[2].toLowerCase();
  const meterNo = m2[3];
  const amount = Number(m2[4]);
  let phone = m2[5].replace(/^\+?234/, '0');
  if (phone.length === 10) phone = '0' + phone;
  if (!Number.isFinite(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, 'Amount must be a positive number.');
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, 'No admin JWT on file. Run /setadmin first.');
  _appendAudit(`${new Date().toISOString()} ELECTRICITY_FIRE sender=${sender.name}/${sender.phone} disco=${disco} type=${type} meter=${meterNo} amount=${amount} phone=${phone}`);
  await _executeOp(msg, {
    kind: 'electricity', disco, type, meterNo, amount, phone,
    senderPhone: sender.phone, senderName: sender.name,
  }, sender);
});

// /buycable <provider> <smartCardNo> <productsCode> ["packagename"] [amount]
//    One-shot, no CONFIRM step. Cable still needs the productsCode
//    explicitly because the package catalog is multi-biller and pulled
//    live; natural-language plan-name lookup is on the roadmap.
bot.onText(/^(?:\/buycable|(?:buy|cable)\b.*?\bcable\b|cable\b.*)(?:\s+(.+))?$/i, async (msg, match) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return bot.sendMessage(msg.chat.id, 'You must /start first.');
  if (sender.permission !== 'full') return bot.sendMessage(msg.chat.id, 'Only full-access users (John, Bukunmi) can buy via the bot.');
  const args = msg.text.trim();  // CEO directive 8 May 2026 - use full
  // message; the trigger regex's lazy match was swallowing tokens like "5GB".
  if (!args || /^help$/i.test(args)) {
    return bot.sendMessage(msg.chat.id,
      'Buy cable:\n' +
      '  buy cable DSTV 1234567890 ng_dstv_compactw7 "Compact" 12000\n' +
      '  buy cable GOTV 1234567890 ng_gotvmaxw7 "Max" 6500\n\n' +
      'Format: <provider> <smartCardNo> <productsCode> <packagename> <amount>\n' +
      'Providers: DSTV, GOTV, STARTIMES.\n' +
      'Get the productsCode from the dashboard catalog or ask me to list dstv plans.\n' +
      'It executes immediately. No CONFIRM step.'
    );
  }
  const provMatch = args.match(/\b(DSTV|GOTV|STARTIMES|SHOWMAX)\b/i);
  const cardMatch = args.match(/\b(\d{8,16})\b/);
  if (!provMatch || !cardMatch) {
    return bot.sendMessage(msg.chat.id, 'I need a provider (DSTV/GOTV/STARTIMES) and a smart card number. Try: /buycable help');
  }
  const type = provMatch[1].toUpperCase();
  const smartCardNo = cardMatch[1];
  let rest = args.replace(provMatch[0], ' ').replace(cardMatch[0], ' ').trim();
  const quoted = rest.match(/"([^"]+)"/);
  let packagename = quoted ? quoted[1] : null;
  if (quoted) rest = rest.replace(quoted[0], ' ').trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  let productsCode = null, amount = null;
  for (const tok of tokens) {
    if (/^\d+(?:\.\d+)?$/.test(tok)) amount = Number(tok);
    else if (!productsCode) productsCode = tok;
    else if (!packagename) packagename = tok;
  }
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, 'No admin JWT on file. Run /setadmin first.');
  _appendAudit(`${new Date().toISOString()} CABLE_FIRE sender=${sender.name}/${sender.phone} provider=${type} smartCard=${smartCardNo} productsCode=${productsCode} packagename=${packagename} amount=${amount}`);
  await _executeOp(msg, {
    kind: 'cable', type, smartCardNo, productsCode, packagename, amount,
    senderPhone: sender.phone, senderName: sender.name,
  }, sender);
});

// ── /fundcancel — drop pending proposal ──────────────────────────────
bot.onText(/^(?:\/fundcancel|fund[\s-]*cancel|cancel[\s-]*fund|cancel)\b/i, async (msg) => {
  const had = _pendingFund.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, had ? '🗑 Pending fund cancelled.' : 'No pending fund to cancel.');
});

// ── _executeOp: shared execution path used by both CONFIRM and the
//    one-shot buy handlers (CEO directive 8 May 2026 — no second tap).
//    Returns nothing; sends the result message itself.
async function _executeOp(msg, op, sender) {
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) {
    await bot.sendMessage(msg.chat.id, '❌ No admin JWT on file. Run /setadmin first.');
    return;
  }
  let resp, body, endpoint, payload, opLabel;
  const kind = op.kind || 'fund';
  if (kind === 'fund') {
    endpoint = `${HW_API_BASE}/api/v2/wallet/manage-wallet`;
    payload = { amount: op.amount, user: op.target, type: op.type, purpose: 'REFUND_REVERSAL', recipient_note: op.purpose };
    opLabel = '/manage-wallet';
  } else if (kind === 'airtime') {
    endpoint = `${HW_API_BASE}/api/v2/airtime/buy`;
    payload = { amount: op.amount, network: op.network, phone: op.phone };
    opLabel = '/airtime/buy';
  } else if (kind === 'data') {
    endpoint = `${HW_API_BASE}/api/v2/data/buy`;
    payload = { planId: op.planId, phone: op.phone };
    opLabel = '/data/buy';
  } else if (kind === 'electricity') {
    endpoint = `${HW_API_BASE}/api/v2/electricity/buy`;
    payload = { type: op.type, disco: op.disco, amount: op.amount, meterNo: op.meterNo, phoneNumber: op.phone };
    opLabel = '/electricity/buy';
  } else if (kind === 'cable') {
    endpoint = `${HW_API_BASE}/api/v2/cables/buy`;
    payload = { smartCardNo: op.smartCardNo, type: op.type };
    if (op.productsCode) payload.productsCode = op.productsCode;
    if (op.packagename) payload.packagename = op.packagename;
    if (op.amount) payload.amount = op.amount;
    opLabel = '/cables/buy';
  } else {
    await bot.sendMessage(msg.chat.id, `❌ Unknown action kind: ${kind}`);
    return;
  }
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Authorization': jwt, 'frontend-source': 'admin', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    body = await resp.text();
  } catch (e) {
    _appendAudit(`${new Date().toISOString()} ${kind.toUpperCase()}_ERROR sender=${sender.name}/${sender.phone} err=${e.message}`);
    await bot.sendMessage(msg.chat.id, `❌ api unreachable: ${e.message}`);
    return;
  }
  const tokens = _loadAdminTokens();
  if (tokens[sender.phone]) { tokens[sender.phone].lastUsedAt = Date.now(); _saveAdminTokens(tokens); }
  _appendAudit(`${new Date().toISOString()} ${kind.toUpperCase()}_FIRE sender=${sender.name}/${sender.phone} payload=${JSON.stringify(payload).slice(0,140)} status=${resp.status}`);
  // CEO directive 7 May 2026 — never dump raw API JSON to Telegram. The
  // success body contains user PII (NIN, BVN, 2FA secrets, KYC state).
  // Pull the human msg field and assemble a clean summary from `op`.
  let apiMsg = '';
  try {
    const j = JSON.parse(body || '{}');
    apiMsg = String(j.msg || j.message || (Array.isArray(j.error) && j.error[0]?.msg) || '').trim();
  } catch (_) {
    apiMsg = String(body || '').slice(0, 200).replace(/[`\n]/g, ' ').trim();
  }
  const fmtNgn = (n) => '\u20a6' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // CEO directive 8 May 2026 — no api status code suffix, no
  // markdown asterisks/italics. Plain prose every time.
  let summary = '';
  if (kind === 'airtime') {
    summary = `Network: ${op.network}\nRecipient: ${op.phone}\nAmount: ${fmtNgn(op.amount)}`;
  } else if (kind === 'data') {
    summary = `Plan: ${op.planLabel || op.planId}\nRecipient: ${op.phone}` + (op.amount ? `\nAmount: ${fmtNgn(op.amount)}` : '');
  } else if (kind === 'electricity') {
    summary = `Disco: ${op.disco}\nMeter: ${op.meterNo}\nType: ${op.type}\nAmount: ${fmtNgn(op.amount)}`;
  } else if (kind === 'cable') {
    summary = `Smart Card: ${op.smartCardNo}\nPlan: ${op.packagename || op.type}` + (op.amount ? `\nAmount: ${fmtNgn(op.amount)}` : '');
  } else if (kind === 'wallet' || kind === 'refund') {
    summary = `User: ${op.target}\nAmount: ${fmtNgn(op.amount)}\nType: ${op.type}\nPurpose: ${op.purpose}`;
  } else {
    summary = `Op: ${kind}`;
  }
  await bot.sendMessage(
    msg.chat.id,
    (resp.ok ? '\u2705 Successful' : '\u274c Failed') + '\n\n' +
    summary + '\n\n' +
    (apiMsg ? apiMsg + '\n\n' : '') +
    (resp.ok ? 'Audit trail on the dashboard will show this action under your admin account.' : 'No money moved. Re-run if you want to retry.'),
  );
}

// CONFIRM keyword still fires for /fund (wallet manage) ops which we
// keep two-step for safety. Buy commands skip this entirely.
bot.onText(/^CONFIRM$/, async (msg) => {
  const op = _pendingFund.get(msg.chat.id);
  if (!op) {
    await bot.sendMessage(msg.chat.id, 'No pending action to confirm.');
    return;
  }
  if (Date.now() > op.expiresAt) {
    _pendingFund.delete(msg.chat.id);
    await bot.sendMessage(msg.chat.id, 'Confirmation window expired. Re-run /fund to propose again.');
    return;
  }
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender || sender.phone !== op.senderPhone) {
    await bot.sendMessage(msg.chat.id, '\u274c Only the proposer can confirm.');
    return;
  }
  _pendingFund.delete(msg.chat.id);
  await _executeOp(msg, op, sender);
});

async function _processClaudePrompt(msg, prompt, user) {
  const t0 = Date.now();
  const text = prompt;
  const promptPreview = text.slice(0, 200).replace(/\n/g, ' ');
  console.log(`[hw-whatsapp-bot] /c invoking — ${user.name} (${user.permission}) — "${promptPreview}"`);
  _appendAudit(`${new Date().toISOString()} START sender=${user.name}/${user.phone} perm=${user.permission} prompt=${JSON.stringify(promptPreview)}`);

  try { await bot.sendChatAction(msg.chat.id, 'typing'); } catch (_) {}
  let thinkingMsg = null;
  try {
    thinkingMsg = await bot.sendMessage(msg.chat.id, '🤔 _Working on it…_', { parse_mode: 'Markdown' });
  } catch (_) {}

  const sessionId = _newSessionId(user);
  // --dangerously-skip-permissions: in non-interactive `-p` mode there
  // is no human to approve each shell/edit/SSH; without this flag,
  // Claude bails on the first new tool with "I need approval to run
  // <command>". The bot is the controlled boundary here — only
  // whitelisted users reach this code path, and for readonly users we
  // still gate via --disallowedTools + system prompt.
  const args = [
    '-p', text,
    '--session-id', sessionId,
    '--add-dir', '/var/www/honour_world',
    '--dangerously-skip-permissions',
  ];
  if (user.permission === 'readonly') {
    args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree');
    args.push('--append-system-prompt', READONLY_SYSTEM_PROMPT);
  }

  // Spawn helper — runs `claude` once with the given args, returns
  // {stdout, stderr, exitCode, timedOut}. Used twice below: once with
  // the per-user --session-id, and (if that errors with "Session ID is
  // already in use") once again WITHOUT --session-id as a fallback.
  // The fallback loses multi-turn context for that single message but
  // unblocks the user — typically only happens after a bot crash leaves
  // a session file in a "claimed" state.
  async function _runClaude(spawnArgs) {
    let so = '', se = '', code = -1, to = false, inflightId = null;
    await new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, spawnArgs, {
        cwd: '/var/www/hw-wa-bot',
        // Drop privileges to hwbot — Claude Code blocks
        // --dangerously-skip-permissions when invoked as root, and -p
        // mode has no human to approve each tool.
        uid: HWBOT_UID,
        gid: HWBOT_GID,
        env: {
          ...process.env,
          HOME: HWBOT_HOME,
          USER: 'hwbot',
          LOGNAME: 'hwbot',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      inflightId = _registerInflight({
        chatId: msg.chat.id,
        thinkingMsgId: thinkingMsg && thinkingMsg.message_id,
        child,
        sender: user.name,
        startedAt: Date.now(),
      });
      const killer = setTimeout(() => { to = true; try { child.kill('SIGKILL'); } catch (_) {} }, CLAUDE_TIMEOUT_MS);
      child.stdout.on('data', (d) => { so += d.toString(); });
      child.stderr.on('data', (d) => { se += d.toString(); });
      child.on('exit', (c) => { clearTimeout(killer); _deregisterInflight(inflightId); code = c; resolve(); });
      child.on('error', (e) => { clearTimeout(killer); _deregisterInflight(inflightId); se += `\nspawn error: ${e.message}`; resolve(); });
    });
    return { stdout: so, stderr: se, exitCode: code, timedOut: to };
  }

  let { stdout, stderr, exitCode, timedOut } = await _runClaude(args);

  // Fallback for the "Session ID is already in use" failure mode —
  // retry WITHOUT --session-id (loses context for this message only).
  const sessionLocked = (
    exitCode !== 0 &&
    /session id .* is already in use/i.test(stdout + stderr)
  );
  if (sessionLocked) {
    console.warn(`[hw-whatsapp-bot] session ${sessionId} locked — retrying without --session-id`);
    _appendAudit(`${new Date().toISOString()} RETRY sender=${user.name}/${user.phone} reason=session_locked`);
    const fallback = [
      '-p', text,
      '--add-dir', '/var/www/honour_world',
      '--dangerously-skip-permissions',
    ];
    if (user.permission === 'readonly') {
      fallback.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree');
      fallback.push('--append-system-prompt', READONLY_SYSTEM_PROMPT);
    }
    const r2 = await _runClaude(fallback);
    stdout = r2.stdout; stderr = r2.stderr; exitCode = r2.exitCode; timedOut = r2.timedOut;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  _appendAudit(`${new Date().toISOString()} END   sender=${user.name}/${user.phone} exit=${exitCode} elapsed=${elapsed}s timedOut=${timedOut} stdoutLen=${stdout.length} stderrLen=${stderr.length}`);

  let body;
  if (timedOut) {
    body = `⏱ Timed out after ${CLAUDE_TIMEOUT_MS / 1000}s. Try a more focused question.`;
  } else if (exitCode !== 0 && !stdout.trim()) {
    body = `❌ Error (exit ${exitCode}): ${stderr.slice(0, CLAUDE_RESPONSE_MAX - 200)}`;
  } else {
    let out = stdout.trim() || stderr.trim() || '(no output)';
    if (out.length > CLAUDE_RESPONSE_MAX - 200) {
      out = out.slice(0, CLAUDE_RESPONSE_MAX - 200) + `\n\n…truncated (${out.length - (CLAUDE_RESPONSE_MAX - 200)} more chars in audit log)`;
    }
    body = out;
  }
  // CEO directive 6 May + 8 May 2026 — no "🤖 *Claude*" prefix and
  // strip every Markdown emphasis (bold/italic/code) from Claude's
  // output. Send as plain text so even if Claude slips and emits a
  // stray asterisk or backtick, the staff never see literal markup.
  const reply = _safeText(_stripClaudeMarkdown(body));
  try {
    await bot.sendMessage(msg.chat.id, reply);
  } catch (e) {
    // Defensive — sendMessage can still throw on transport errors.
    try { await bot.sendMessage(msg.chat.id, _safeText(body)); } catch (_) {}
  }
  // Clean up the "thinking" message
  if (thinkingMsg) {
    try { await bot.deleteMessage(msg.chat.id, thinkingMsg.message_id); } catch (_) {}
  }
}

// Explicit /c trigger (still works — original interface)
bot.onText(/^\/c\b/i, async (msg) => {
  const user = _findUserByTelegramId(msg.from?.id);
  if (!user) {
    await bot.sendMessage(msg.chat.id, 'Please send /start first to verify your access.');
    return;
  }
  const prompt = (msg.text || '').replace(/^\/c\s*/i, '').trim();
  if (!prompt) {
    await bot.sendMessage(msg.chat.id, 'Type your question and I will answer it.', { parse_mode: 'Markdown' });
    return;
  }
  await _processClaudePrompt(msg, prompt, user).catch((e) => console.error('[hw-whatsapp-bot] /c error:', e?.message));
});

// COO directive 6 May 2026 — /c is OPTIONAL in 1:1 DMs. Any plain text
// message from a registered user in a private chat with the bot is
// automatically treated as a /c prompt. Slash commands (/start, /c,
// /help) and contact shares are still handled by their own listeners.
bot.on('message', async (msg) => {
  // Skip slash commands, CONFIRM keyword, and natural-language buy/fund
  // commands — they all have dedicated bot.onText handlers and double-firing
  // through the AI path causes confusing duplicate replies AND races with
  // the in-memory _pendingFund map (CEO directive 7 May 2026).
  const text = (msg.text || '').trim();
  if (/^\//.test(text)) return;
  if (/^CONFIRM$/.test(text)) return;
  if (/^(?:buy[\s-]*airtime|send[\s-]*airtime|airtime|buy[\s-]*data|data|buy[\s-]*electricity|electricity|buy[\s-]*cable|cable|fund|fund[\s-]*cancel|cancel[\s-]*fund|cancel|(?:buy|send)\s+\d+(?:\.\d+)?\s*(?:gb|mb|tb)\b)\b/i.test(text)) return;

  if (!msg.text) return;
  if (msg.text.startsWith('/')) return; // slash commands handled elsewhere
  if (msg.contact) return; // contact shares handled separately

  // Only auto-treat as Claude prompt in PRIVATE chats. In groups,
  // require explicit /c so the bot doesn't spam every message.
  if (msg.chat?.type !== 'private') return;

  const user = _findUserByTelegramId(msg.from?.id);
  if (!user) {
    await bot.sendMessage(msg.chat.id, 'Please send /start first to verify your access.');
    return;
  }

  await _processClaudePrompt(msg, msg.text.trim(), user).catch((e) => console.error('[hw-whatsapp-bot] DM error:', e?.message));
});

console.log('[hw-whatsapp-bot] WhatsApp transport ready');

// ── HTTP API for outbound alerts (backward-compat with hw_wa_notify.py) ──
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  if (!SHARED_TOKEN) return next(); // loopback-open until a token is configured
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7).trim() !== SHARED_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.get('/healthz', (_req, res) => {
  const db = _loadUsers();
  res.json({
    ok: true,
    bot: 'whatsapp',
    connected: _connected,
    registeredUsers: Object.keys(db).length,
    users: Object.values(db).map((u) => ({ name: u.name, phone: u.phone, permission: u.permission })),
  });
});

app.post('/send', async (req, res) => {
  // Dedup guard — skip identical (to + message + image) within last 60s.
  const dedup = _isDuplicateSend(req.body || {});
  if (dedup.duplicate) {
    console.log(`[bot-send] dedup skip — same payload sent ${dedup.ageMs}ms ago`);
    return res.json({ ok: true, deduplicated: true, ageMs: dedup.ageMs });
  }

  // CEO directive 8 May 2026 — accept an optional `image` field (URL) so
  // alerts (e.g. SIM-airtime low-balance per network) can ship the network
  // logo as a Telegram photo with the body as caption. When `image` is
  // provided, we use bot.sendPhoto; otherwise the legacy sendMessage path.
  // Telegram caption limit is 1024 chars — overflow falls back to a
  // photo + follow-up text message.
  const { to, message, image } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: '`to` and `message` required' });

  // `to` may be: (a) a phone number (look up registered user),
  //              (b) "all-full" / "all-readonly" / "all" (broadcast),
  //              (c) a numeric Telegram chat_id (advanced).
  const db = _loadUsers();
  let recipients = [];
  const toStr = String(to).trim();
  if (toStr === 'all' || toStr === 'all-full' || toStr === 'all-readonly') {
    const filt = toStr === 'all' ? null : toStr === 'all-full' ? 'full' : 'readonly';
    const all = Object.values(db).filter((u) => !filt || u.permission === filt);
    // CEO directive 9 May 2026 — dedupe recipients by phone (or jid).
    // The user db keys some entries twice (bare phone + JID-suffixed)
    // so Object.values returned the same person twice and the loop
    // below sent the same alert twice on WhatsApp. The 60s send-dedup
    // at the top of /send only fires for repeated /send calls, not
    // for internal recipient duplication.
    const seen = new Set();
    recipients = [];
    for (const u of all) {
      const key = String(u.phone || u.jid || u.chatId || '');
      if (seen.has(key)) continue;
      seen.add(key);
      recipients.push(u);
    }
  } else if (toStr.startsWith('tg:')) {
    // Explicit chat_id form: "tg:896318801"
    const id = parseInt(toStr.slice(3), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: `invalid tg: chat_id "${toStr}"` });
    recipients = [{ chatId: id, name: '(direct chat_id)', phone: '' }];
  } else {
    // Phone form: "+234...", "234...", "0...", or "234XXXXXXXXXX".
    // Heuristic: if it normalises to a phone we know, ship it; if not
    // and it's a short numeric (≤ 11 digits, like a 9-digit Telegram
    // chat_id), fall back to treating it as a chat_id.
    const phone = _normalisePhone(toStr);
    const found = Object.values(db).find((u) => u.phone === phone);
    if (found) {
      recipients = [found];
    } else if (/^-?\d+$/.test(toStr) && toStr.length <= 11) {
      // Could be a Telegram numeric chat_id (5–11 digits typical).
      recipients = [{ chatId: parseInt(toStr, 10), name: '(direct chat_id)', phone: '' }];
    } else {
      return res.status(404).json({
        error: `no registered Telegram user for phone ${phone} — they need to /start the bot first (or pass "tg:<chat_id>" explicitly)`,
        registeredUsers: Object.values(db).map((u) => ({ name: u.name, phone: u.phone })),
      });
    }
  }

  const results = [];
  const TG_CAPTION_MAX = 1024;
  for (const r of recipients) {
    try {
      let sent;
      if (image && typeof image === 'string') {
        // Photo with caption; if message exceeds Telegram's 1024-char
        // caption limit, send the photo with no caption and follow up
        // with the full text in a separate message.
        const msgStr = String(message);
        if (msgStr.length <= TG_CAPTION_MAX) {
          sent = await bot.sendPhoto((r.jid || r.chatId || r.phone), image, {
            caption: msgStr,
            parse_mode: 'Markdown',
          });
        } else {
          await bot.sendPhoto((r.jid || r.chatId || r.phone), image);
          sent = await bot.sendMessage((r.jid || r.chatId || r.phone), msgStr, { parse_mode: 'Markdown' });
        }
      } else {
        sent = await bot.sendMessage((r.jid || r.chatId || r.phone), String(message), { parse_mode: 'Markdown' });
      }
      results.push({ ok: true, name: r.name, msgId: sent.message_id });
    } catch (e) {
      // Markdown parse failure or photo URL fetch failure → retry plain text
      try {
        const sent = await bot.sendMessage((r.jid || r.chatId || r.phone), String(message));
        results.push({ ok: true, name: r.name, msgId: sent.message_id, plain: true });
      } catch (e2) {
        results.push({ ok: false, name: r.name, error: e2?.message || 'send failed' });
      }
    }
  }
  res.json({ ok: results.every((r) => r.ok), results });
});

app.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[hw-whatsapp-bot] HTTP API listening on 127.0.0.1:${HTTP_PORT}`);
});

async function _gracefulShutdown(signal) {
  if (_SHUTTING_DOWN) return;
  _SHUTTING_DOWN = true;
  console.log(`[hw-whatsapp-bot] ${signal} — notifying ${_INFLIGHT.size} in-flight chat(s)`);
  // Notify each pending thread + kill its Claude child so we don't
  // leave orphaned "Working on it..." bubbles in any user's chat.
  const tasks = [];
  for (const [id, rec] of _INFLIGHT) {
    tasks.push((async () => {
      try {
        if (rec.thinkingMsgId) {
          await bot.editMessageText(
            '⚠️ _Server restarted before I could finish that. Please send the question again._',
            { chat_id: rec.chatId, message_id: rec.thinkingMsgId, parse_mode: 'Markdown' }
          );
        } else {
          await bot.sendMessage(rec.chatId, '⚠️ Server restarted before I could finish your previous question. Please send it again.');
        }
      } catch (_) {}
      try { rec.child && rec.child.kill('SIGKILL'); } catch (_) {}
      _appendAudit(`${new Date().toISOString()} ABORT sender=${rec.sender} reason=${signal} elapsed=${((Date.now()-rec.startedAt)/1000).toFixed(1)}s`);
      _INFLIGHT.delete(id);
    })());
  }
  // Cap shutdown wait so systemd doesn't SIGKILL us mid-notify
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  console.log('[hw-whatsapp-bot] shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));

// Boot Baileys connection.
_connectWhatsApp().catch((e) => { log.error(e, 'fatal: connect'); process.exit(1); });
