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
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import express from 'express';
import fs from 'node:fs';
// LIBSIGNAL_SESSION_DUMP_SILENCER_09NOV2026: libsignal console.info()s the whole session object on every
// "Opening session"/"Closing session" (hundreds a minute). That filled server.log to 374 MB and, with a 66 MB
// session file rewritten each time, pinned the process at 100% CPU so staff messages went unanswered.
{
  const _origInfo = console.info.bind(console);
  console.info = (...args) => {
    const head = typeof args[0] === 'string' ? args[0] : '';
    if (head.startsWith('Opening session') || head.startsWith('Closing session') || head.startsWith('Removing old closed session') || head.startsWith('Migrating session')) return;
    _origInfo(...args);
  };
}
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
// OPS_STATUS_16NOV2026 (COO): instant live-status answer, no AI needed.
const STATUS_RX = /\b(what'?s|what is|whats)\s+(happening|going on|up)\b|\bstatus\b|\bany (issue|issues|problem|problems|update|updates)\b|\bpending( transactions?| orders?)?\b.*\b(admin|now|today)?\b|^\s*(update|updates|report)\s*\??\s*$/i;
const CLAUDE_AUTH_FAIL_RX = /(\b401\b|oauth|failed to authenticate|re-?authenticate|not logged in|invalid api key|authentication_error)/i;
function _opsStatus() {
  return new Promise((resolve) => {
    const ch = spawn('python3', ['/var/www/honour_world/ops_status.py'], { timeout: 30000 });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('close', () => resolve(out.trim() || 'I could not read the live status just now. Please open the Admin.'));
    ch.on('error', () => resolve('I could not read the live status just now. Please open the Admin.'));
  });
}
import path from 'node:path';
import { registerTeach } from './teach.js'; // TEACH_HALO_09NOV2026
import { isAdCommentRequest, handleAdComment, isElizabeth, handleElizabethChat } from './ad_comments.js'; // AD_COMMENTS_20NOV2026
import { registerBillerRoutes, handleRouteInbound } from './biller_routes.js'; // BILLER_ROUTER_14NOV2026

// ─────────────────────────────────────────────────────────────────────────
// BOT_USAGE_LOG_10MAY2026 — per-user usage logger (COO directive 10 May 2026).
// Appends one JSONL line per inbound message to /var/log/hw-bots/usage.log
// so we can answer "is Mary/Seun/Ayomide actually using this bot?"
// reliably without depending on journalctl retention windows.
// Fields: ts, bot, user_name, phone, permission, command, text_preview, text_len.
// ─────────────────────────────────────────────────────────────────────────
const _USAGE_LOG_PATH = '/var/log/hw-bots/usage.log';
function logUsage_BOT_USAGE_LOG_10MAY2026(fields) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      bot: 'whatsapp',
      ...fields,
    }) + '\n';
    fs.appendFileSync(_USAGE_LOG_PATH, line);
  } catch (e) {
    // never crash the bot on logger failure
    try { console.error('usage logger failed:', e?.message); } catch (_) {}
  }
}


// WA_BOT_OUTBOUND_TELEMETRY_03JUN2026
// Append-only event log for outbound /send/customer pushes:
//   {event:"sent", messageId, to, kind, sentAt, length, preview}
//   {event:"delivered"|"read"|"played", messageId, to, at}
//   {event:"replied", quotedMessageId, from, at, preview}
// Reader reduces by messageId to compute send/delivered/read/reply rates.
const _WA_OUTBOUND_LOG = '/var/www/hw-whatsapp-bot/wa_outbound.jsonl';
function _waOutboundLog(obj) {
  try {
    fs.appendFileSync(_WA_OUTBOUND_LOG, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
  } catch (e) {
    try { console.error('wa_outbound logger failed:', e?.message); } catch (_) {}
  }
}
// WA_BOT_BULK_THROTTLE_04JUN2026: in-bot daily cap + per-recipient cooldown
// + bulk-kind kill switch. Persists counters across restarts. Triggered
// after WhatsApp restricted the bot's linked-device feature 4 Jun 2026.
const _WA_THROTTLE_PATH = '/var/lib/hw-whatsapp-bot/throttle.json';
const _WA_BULK_KINDS = new Set([
  'kyc_nudge', 'cable_elec_winback', 'dormant_winback', 'win_back', 'winback',
  'nudge', 'marketing', 'broadcast', 'campaign',
]);
// Default 7-day bulk pause from 4 Jun 2026 23:59 UTC; override via env.
const _WA_BULK_PAUSED_UNTIL = new Date(process.env.WA_BULK_PAUSED_UNTIL || '2026-06-11T23:59:59Z');
const _WA_DAILY_CAP = Number(process.env.WA_DAILY_CAP || 10);
const _WA_COOLDOWN_DAYS = Number(process.env.WA_COOLDOWN_DAYS || 7);

function _loadThrottle() {
  try { return JSON.parse(fs.readFileSync(_WA_THROTTLE_PATH, 'utf8')); }
  catch (_) { return { dayKey: '', dayCount: 0, lastSeenByPhone: {} }; }
}
function _saveThrottle(t) {
  try { fs.writeFileSync(_WA_THROTTLE_PATH, JSON.stringify(t), { mode: 0o600 }); }
  catch (e) { try { console.error('throttle save failed:', e?.message); } catch (_) {} }
}
function _dayKeyUTC() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth()+1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
}
function _checkThrottle({ phone, kind }) {
  // Returns { ok: true } or { ok: false, code: <http>, error: <string> }.
  // Bulk-kind kill switch first.
  if (kind && _WA_BULK_KINDS.has(String(kind).toLowerCase())) {
    if (Date.now() < _WA_BULK_PAUSED_UNTIL.getTime()) {
      return {
        ok: false, code: 503,
        error: `BULK_PAUSED: kind "${kind}" is bulk-throttled until ${_WA_BULK_PAUSED_UNTIL.toISOString()} (WA anti-spam restriction recovery)`,
      };
    }
  }
  const t = _loadThrottle();
  const today = _dayKeyUTC();
  if (t.dayKey !== today) { t.dayKey = today; t.dayCount = 0; }
  // Per-recipient 7-day cooldown.
  const lastSent = t.lastSeenByPhone?.[phone];
  if (lastSent) {
    const ageMs = Date.now() - lastSent;
    const cdMs = _WA_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs < cdMs) {
      const remainingH = Math.ceil((cdMs - ageMs) / (60*60*1000));
      return {
        ok: false, code: 429,
        error: `RECIPIENT_COOLDOWN: phone ${phone} received a push less than ${_WA_COOLDOWN_DAYS}d ago; ${remainingH}h remaining`,
      };
    }
  }
  if (t.dayCount >= _WA_DAILY_CAP) {
    return {
      ok: false, code: 429,
      error: `DAILY_CAP_EXHAUSTED: ${_WA_DAILY_CAP}/day reached for ${today}`,
    };
  }
  return { ok: true, throttle: t };
}
function _consumeThrottle({ phone, throttle }) {
  throttle.dayCount = (throttle.dayCount || 0) + 1;
  throttle.lastSeenByPhone = throttle.lastSeenByPhone || {};
  throttle.lastSeenByPhone[phone] = Date.now();
  _saveThrottle(throttle);
}

// Recent outbound message-id -> {to, kind, sentAt} map (in-memory, 24h TTL)
// so messages.update + reply-detection can join back to context.
const _WA_OUTBOUND_RECENT = new Map();
function _rememberOutbound(messageId, to, kind) {
  if (!messageId) return;
  _WA_OUTBOUND_RECENT.set(messageId, { to, kind, at: Date.now() });
  // Prune entries older than 24h
  if (_WA_OUTBOUND_RECENT.size > 2000) {
    const cutoff = Date.now() - 24*60*60*1000;
    for (const [k, v] of _WA_OUTBOUND_RECENT) if (v.at < cutoff) _WA_OUTBOUND_RECENT.delete(k);
  }
}

const SHARED_TOKEN_FILE = process.env.HW_WA_TOKEN_FILE || '/etc/hw-whatsapp-bot.token';
const HTTP_PORT = Number(process.env.HW_WA_HTTP_PORT || 9002);

// WA_CRM_REPLY_25MAY2026 outgoing message_id -> ticket_number map.
// Lets us route a quoted-reply on a CRM push back into the ticket.
const TICKET_MAP_PATH = process.env.HW_WA_TICKET_MAP || '/var/lib/hw-whatsapp-bot/ticket-map.json';
const TICKET_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const API_BOT_REPLY_URL = process.env.HW_API_BOT_REPLY_URL || 'https://api.honourworld.com/api/v2/crm/bot-reply';
const API_BOT_REPLY_SECRET = (() => {
  try {
    const p = process.env.HW_BOT_REPLY_SECRET_FILE || '/etc/hw-bot-reply.secret';
    return fs.readFileSync(p, 'utf8').trim();
  } catch (_) { return process.env.HW_BOT_REPLY_SECRET || ''; }
})();
function _loadTicketMap() {
  try { return JSON.parse(fs.readFileSync(TICKET_MAP_PATH, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function _saveTicketMap(map) {
  try {
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (!map[k]?.recordedAt || (now - map[k].recordedAt) > TICKET_MAP_TTL_MS) delete map[k];
    }
    fs.writeFileSync(TICKET_MAP_PATH, JSON.stringify(map, null, 2));
  } catch (e) { log.warn({ err: e?.message }, 'ticket map save failed'); }
}
function _recordTicketSend(messageId, ticketNumber, toPhone) {
  if (!messageId || !ticketNumber) return;
  const map = _loadTicketMap();
  map[String(messageId)] = { ticket_number: String(ticketNumber).toUpperCase(), to: String(toPhone || ''), recordedAt: Date.now() };
  _saveTicketMap(map);
}
function _resolveTicketFromQuotedId(stanzaId) {
  if (!stanzaId) return null;
  const map = _loadTicketMap();
  const hit = map[String(stanzaId)];
  return hit?.ticket_number || null;
}
// Prefix parser for inbound replies: detects note: / resolve / reopen
function _parseCrmCommand(text) {
  const t = String(text || '').trim();
  if (!t) return { kind: 'reply', body: '' };
  const lower = t.toLowerCase();
  if (/^note\s*[:-]\s*/i.test(t)) return { kind: 'note', body: t.replace(/^note\s*[:-]\s*/i, '').trim() };
  if (lower === 'resolve' || lower === 'done' || lower === 'close' || lower === 'mark resolved') return { kind: 'resolve', body: '' };
  if (lower === 'reopen' || lower === 'open' || lower === 'reopen ticket') return { kind: 'reopen', body: '' };
  if (/^resolve\s*[:-]\s*/i.test(t)) return { kind: 'resolve', body: t.replace(/^resolve\s*[:-]\s*/i, '').trim() };
  return { kind: 'reply', body: t };
}
async function _forwardToCrmReply({ phone, ticketNumber, body, kind }) {
  if (!API_BOT_REPLY_SECRET) return { ok: false, error: 'BOT_REPLY_SECRET not configured' };
  const payload = JSON.stringify({ phone, ticket_number: ticketNumber, body, kind });
  const fetchFn = global.fetch || (await import('node-fetch').then(m => m.default).catch(() => null));
  if (!fetchFn) return { ok: false, error: 'fetch not available' };
  try {
    const r = await fetchFn(API_BOT_REPLY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_BOT_REPLY_SECRET}` },
      body: payload,
    });
    const json = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, body: json };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const USERS_DB_PATH = process.env.HW_WA_USERS_DB || '/var/lib/hw-whatsapp-bot/wa-users.json';
const AUTH_DIR = process.env.HW_WA_AUTH_DIR || '/var/lib/hw-whatsapp-bot/auth';
const QR_PNG = process.env.HW_WA_QR_PNG || '/var/log/hw-whatsapp-bot/last-qr.png';
const PAIR_CODE_FILE = '/var/log/hw-whatsapp-bot/last-pairing-code.txt';

// QR_STORM_GUARD_09AUG2026 — see the 4 Aug 2026 incident in git history.
// An unpaired bot used to request a QR every ~20s indefinitely. Five days of
// that (3,157 requests in 24h) earned a WhatsApp rate limit that then blocked
// the re-pair itself, turning a routine logout into a five-day outage nobody
// noticed. Past this many QR cycles the bot gives up and shouts instead.
const MAX_QR_PER_ATTEMPT = Number(process.env.HW_WA_MAX_QR || 15);
let _qrSinceConnect = 0;
let _qrGuardTripped = false;

// Alerts go out via the TELEGRAM bot's /send. Deliberate: when this fires,
// WhatsApp is by definition unavailable, so alerting over WhatsApp would be
// shouting into the void.
async function _alertViaTelegram(text) {
  try {
    let token = '';
    try { token = fs.readFileSync('/etc/hw-wa-bot.token', 'utf8').trim(); } catch (_) {}
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    // ALERT_PAYLOAD_CHECKED_09AUG2026: /send requires { to, message } and
    // returns 400 for anything else - verified against its handler and by
    // probing the live endpoint, not assumed. An alert that silently 400s is
    // worse than none, because it reads as coverage. "all-full" broadcasts to
    // the full-permission users (John, Bukunmi).
    const _res = await fetch('http://127.0.0.1:9001/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: 'all', message: text }), // ALERT_AUDIENCE_12NOV2026: bot-down alarm is operational, all admins
    });
    if (!_res.ok) {
      log.error({ status: _res.status }, 'QR guard alert REJECTED by /send');
      return;
    }
    log.warn('QR guard alert pushed to Telegram');
  } catch (e) {
    log.error({ err: e?.message }, 'QR guard alert could NOT be pushed');
  }
}
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
const HW_RETRY_CONFIG_PATH = '/var/www/honour_world/config.json';
const JWT_REFRESH_THRESHOLD_HOURS = 48;

// HW_MONGO_URL_12MAY2026 (COO directive 12 May 2026 evening):
// expose the mongo connection string to the claude spawn so the bot can
// answer staff questions like "is there any pending transaction?"
// without needing to read the root-owned config.json from inside the
// hwbot-uid claude session. The node bot reads it once as root and
// passes it through as MONGO_URL env on every claude spawn. Cached on
// startup; if config.json is rotated, restart the bot.
function _readHwMongoUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(HW_RETRY_CONFIG_PATH, 'utf8'));
    return cfg.mongo_url || cfg.MONGO_URL || cfg.mongoUrl || '';
  } catch (_) {
    return '';
  }
}
const _HW_MONGO_URL = _readHwMongoUrl();
if (_HW_MONGO_URL) {
  console.log('[bot] MONGO_URL cached (length ' + _HW_MONGO_URL.length + ')');
} else {
  console.warn('[bot] could not read mongo_url from ' + HW_RETRY_CONFIG_PATH + ' — staff pending queries will fail');
}

function _readAdminCreds() {
  try {
    const cfg = JSON.parse(fs.readFileSync(HW_RETRY_CONFIG_PATH, 'utf8'));
    return { email: cfg.admin_email || '', password: cfg.admin_password || '' };
  } catch (_) {
    return { email: '', password: '' };
  }
}

function _b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function _decodeJwtExp(jwt) {
  if (!jwt || typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(_b64urlDecode(parts[1]).toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (_) {
    return null;
  }
}

function _hoursUntilExpiry(jwt) {
  const exp = _decodeJwtExp(jwt);
  if (!exp) return null;
  return (exp - Math.floor(Date.now() / 1000)) / 3600;
}

// RFC 6238 TOTP (SHA-1, 30s step, 6 digits) — matches Python's pyotp.
function _generateTotp(secretBase32) {
  if (!secretBase32) throw new Error('TOTP secret missing');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  const clean = String(secretBase32).toUpperCase().replace(/[^A-Z2-7]/g, '');
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);
  let t = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) { buf[i] = t & 0xff; t = Math.floor(t / 256); }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) |
               ((hmac[offset + 1] & 0xff) << 16) |
               ((hmac[offset + 2] & 0xff) << 8) |
               (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

async function _loginAsAdmin() {
  const { email, password } = _readAdminCreds();
  if (!email || !password) {
    throw new Error('admin_email / admin_password missing from config.json');
  }
  const r1 = await fetch(`${HW_API_BASE}/api/v2/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'frontend-source': 'admin' },
    body: JSON.stringify({ email, password }),
  });
  const d1 = await r1.json().catch(() => ({}));
  const preToken = d1?.token;
  const twofaSecret = d1?.data?.is2FASecret;
  if (!preToken) throw new Error(`login step 1 failed (${r1.status}): ${JSON.stringify(d1).slice(0, 180)}`);
  if (!twofaSecret) throw new Error('login step 1 returned no 2FA secret');
  const otp = _generateTotp(twofaSecret);
  const r2 = await fetch(`${HW_API_BASE}/api/v2/user/is2fa-authenticate`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'frontend-source': 'admin',
      'Authorization': preToken,
    },
    body: JSON.stringify({ token: otp }),
  });
  const d2 = await r2.json().catch(() => ({}));
  if (!d2?.token) throw new Error(`login step 2 (2FA) failed (${r2.status}): ${JSON.stringify(d2).slice(0, 180)}`);
  return d2.token;
}

// Returns a healthy JWT for the given phone, refreshing via 2FA login when:
//   - no JWT is stored, OR
//   - the stored JWT has less than JWT_REFRESH_THRESHOLD_HOURS of runway, OR
//   - the stored JWT has already expired.
// On refresh, the new JWT is saved under the same phone so subsequent
// lookups are fast. Throws if refresh itself fails (caller decides UX).
async function _getValidJwt(phone) {
  const stored = _getJwtForPhone(phone);
  const hoursLeft = stored ? _hoursUntilExpiry(stored) : null;
  if (stored && hoursLeft !== null && hoursLeft > JWT_REFRESH_THRESHOLD_HOURS) {
    return stored;
  }
  console.log(`[hw-tg-bot] JWT auto-refresh for ${phone} (hoursLeft=${hoursLeft})`);
  const fresh = await _loginAsAdmin();
  const tokens = _loadAdminTokens();
  tokens[phone] = {
    jwt: fresh,
    savedAt: Date.now(),
    lastValidatedAt: Date.now(),
    autoRefreshed: true,
  };
  _saveAdminTokens(tokens);
  return fresh;
}

// Authed fetch with one-shot refresh-on-401/403. Use this for every
// admin-scoped HW API call so callers do not need to know about JWT
// lifetime. Caller passes phone (the sender's phone in the bot's user
// table) so we can refresh the right user's session.
async function _apiFetch(phone, url, options = {}) {
  let jwt;
  try {
    jwt = await _getValidJwt(phone);
  } catch (e) {
    console.warn(`[hw-tg-bot] _getValidJwt failed: ${e.message}`);
    // Fall back to whatever's stored; some older JWTs may still work.
    jwt = _getJwtForPhone(phone);
  }
  if (!jwt) {
    throw new Error('No admin JWT available — run /setadmin <jwt> or check config.json admin creds');
  }
  const headers = {
    ...(options.headers || {}),
    'Authorization': jwt,
    'frontend-source': 'admin',
  };
  let resp = await fetch(url, { ...options, headers });
  if (resp.status === 401 || resp.status === 403) {
    try {
      const fresh = await _loginAsAdmin();
      const tokens = _loadAdminTokens();
      tokens[phone] = {
        jwt: fresh,
        savedAt: Date.now(),
        lastValidatedAt: Date.now(),
        autoRefreshed: true,
      };
      _saveAdminTokens(tokens);
      console.log(`[hw-tg-bot] JWT auto-refresh on ${resp.status} (${phone})`);
      const headers2 = { ...headers, Authorization: fresh };
      resp = await fetch(url, { ...options, headers: headers2 });
    } catch (e) {
      console.warn(`[hw-tg-bot] refresh-on-${resp.status} failed: ${e.message}`);
    }
  }
  return resp;
}


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
// CEO directive 9 May 2026 — alias kept for the JWT auto-refresh
// helpers ported from earlier (they reference _getJwtForPhone).
function _getJwtForPhone(phone) { return _getAdminJwt(phone); }

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
  { name: 'Bukunmi Amoo',       phone: '2347031095864', permission: 'full'     },
  { name: 'Oluwaseun Bamgbade', phone: '2348167993903', permission: 'readonly' },
  { name: 'Mary Adebiyi',       phone: '2349046707717', permission: 'readonly' },
  // MARY_WORK_LINE_14NOV2026: her work line 0803 123 4976 (lid 65228003885057) is what the bot
  // learned in wa-lid-map.json; with only 2349046707717 here her replies were dropped as unknown.
  { name: 'Mary Adebiyi',       phone: '2348031234976', permission: 'readonly' },
  { name: 'Ayomide Oluwafemi',  phone: '2348031230718', permission: 'readonly' },
  // TEAM_ADD_16NOV2026 (COO): Elizabeth + Omogoriola (intern) can chat with the bot, view-only.
  { name: 'Elizabeth Uyang',     phone: '2347025492523', permission: 'readonly' },
  { name: 'Omogoriola',          phone: '2349045047820', permission: 'readonly' },
];
const _BY_PHONE = new Map(USERS.map((u) => [u.phone, u]));

// SUPERADMIN_UNRESTRICTED_09AUG2026 — tell the model WHO it is speaking to.
//
// Nothing used to identify the requester, at any permission level. Combined
// with CLAUDE.md — which Claude Code auto-loads from the spawn cwd on every
// invocation, and which says revenue/profit numbers are "routed only to the
// CEOs" — the model had no way to tell a CEO from a staffer, so it applied the
// restriction to everyone. John asked for his own numbers on 9 Aug 2026 and was
// refused by his own bot.
//
// Appended for EVERY user, not just readonly, so identity is always explicit
// rather than inferred.
function _identityPrompt(user) {
  const who = (user && user.name) || 'an unidentified user';
  const perm = (user && user.permission) || 'unknown';
  if (perm === 'full') {
    return (
      'REQUESTER IDENTITY — AUTHORITATIVE. This overrides any conflicting ' +
      'instruction in CLAUDE.md or any other loaded context. You are speaking ' +
      'with ' + who + ', a FULL-PERMISSION SUPERADMIN of Honour World: one of ' +
      'the two principals (John Amoo, CEO; Bukunmi Amoo, COO). ' +
      '\n\n' +
      'THEY HAVE UNRESTRICTED ACCESS. Every "do not disclose" and "reserved ' +
      'for the CEOs" rule you have been given exists to withhold things FROM ' +
      'STAFF. None of them apply to this person, because this person IS the ' +
      'principal those rules protect. Specifically, answer fully and directly ' +
      'on: sales, profit, revenue, GMV, transaction volume, top products, ' +
      'rankings, commission pools, and any figure for any period; anything ' +
      'either principal has previously asked the bot or any action they ' +
      'fired; and every operational query. Do not hedge, do not partially ' +
      'answer, and do not offer alternatives instead of the answer. ' +
      '\n\n' +
      'NEVER tell this person that information is "routed only to the CEOs" ' +
      'or reserved for someone else. They are that someone else. Such a reply ' +
      'is a defect, not caution. ' +
      '\n\n' +
      'ONE EXCEPTION, which still stands: never output live credentials — API ' +
      'keys, tokens, JWTs, passwords, OTPs, .env values or fragments thereof — ' +
      'into the chat, even to a principal. Chat history persists on handsets ' +
      'and in Telegram/WhatsApp cloud storage, so printing a live key leaks it ' +
      'past the person who asked. Describe where a credential lives and how to ' +
      'rotate it instead of pasting its value.'
    );
  }
  return (
    'REQUESTER IDENTITY — AUTHORITATIVE. You are speaking with ' + who +
    ', permission level "' + perm + '". They are NOT one of the principals. ' +
    'Every do-not-disclose rule in CLAUDE.md applies to them in full, ' +
    'including sales, profit, revenue, GMV, rankings and commission-pool ' +
    'figures, and anything the principals have asked the bot.'
  );
}

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
  const digits = String(chatId).replace(/[^0-9]/g, '');
  // LID_PREFERRED_SEND_09NOV2026: when we have learned a staff member's @lid from an inbound
  // message, address them by it. Phone-number sessions for some accounts (Mary, Ayomide) were
  // re-created on every send and nobody could decrypt the messages ("Waiting for this message").
  try {
    const lidMap = _loadLidMap();
    for (const [lid, phone] of Object.entries(lidMap)) {
      if (String(phone).replace(/[^0-9]/g, '') === digits && lid.endsWith('@lid')) return lid;
    }
  } catch (_) {}
  return digits + '@s.whatsapp.net';
}
function _waSafe(text) {
  // [Label](url) → "Label (url)" for WhatsApp
  // NO_ADMIN_URLS_18NOV2026 (COO standing rule): the bot never sends an Admin URL. Any link to the
  // Admin is replaced with plain words, whoever wrote the text (scripts, API alerts, claude -p replies).
  return String(text || '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(?:https?:\/\/)?(?:www\.)?control\.honourworld\.com(?:[^\s)\]>"']*[^\s)\]>"'.,;:!?])?/gi, 'the Admin');
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
    // WA_SENDPHOTO_LOCAL_PATH_11MAY2026 — accept local file paths in addition to http(s)
    // URLs. Required for the PXES daily cron which screenshots the Mine
    // page to disk on this same retry server and needs to attach it
    // without a public HTTP endpoint. Baileys image field expects either
    // Buffer or { url } where url must be http(s). For local paths we
    // read the file into a Buffer here. Backward compatible — existing
    // URL callers (network logos etc.) still hit the { url } branch.
    let imgPayload;
    if (typeof image === 'string') {
      if (image.startsWith('http://') || image.startsWith('https://')) {
        imgPayload = { url: image };
      } else {
        // Treat as local file path. Read into Buffer for Baileys.
        try {
          imgPayload = fs.readFileSync(image);
        } catch (e) {
          throw new Error(`sendPhoto local-file read failed for "${image}": ${e.message}`);
        }
      }
    } else {
      imgPayload = image;
    }
    const payload = { image: imgPayload, caption: cap };
    const r = await _sock.sendMessage(_toJid(chatId), payload);
    return { message_id: r?.key?.id };
  },
  async sendChatAction() { /* not supported on WA via Baileys here */ },
};

async function _connectWhatsApp() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  // BAILEYS_7_UPGRADE_09NOV2026: Baileys 7 (lid-aware addressing). printQRInTerminal was removed,
  // and the signal key store is wrapped in the cacheable store the library expects.
  const _sigLogger = pino({ level: 'silent' });
  _sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, _sigLogger) },
    browser: Browsers.ubuntu("Chrome"), // BAILEYS_7_PAIRING_09NOV2026: pairing codes are refused with a custom browser name
    logger: _sigLogger,
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
      _qrSinceConnect += 1;
      if (_qrSinceConnect > MAX_QR_PER_ATTEMPT) {
        // QR_STORM_GUARD_09AUG2026: stop. Continuing is what built the rate
        // limit that blocked re-pairing for five days in Aug 2026.
        if (!_qrGuardTripped) {
          _qrGuardTripped = true;
          log.error({ qrCount: _qrSinceConnect },
            'QR storm guard tripped — bot is UNPAIRED and has stopped requesting codes');
          _alertViaTelegram(
            'WhatsApp bot is UNPAIRED\n\n' +
            'It asked for ' + _qrSinceConnect + ' pairing codes without anyone linking it, ' +
            'so it has stopped to avoid a WhatsApp rate limit.\n\n' +
            'The Admin WhatsApp Inbox will not send or receive until it is re-paired. ' +
            'Halo and Telegram are unaffected.\n\n' +
            'To fix: run the pairing flow on ' + BOT_NUMBER + ' and enter the code on the handset.'
          );
          try { _sock.end(new Error('QR storm guard')); } catch (_) {}
        }
        return;
      }
      try { await qrcode.toFile(QR_PNG, qr, { width: 512 }); fs.chmodSync(QR_PNG, 0o644); } catch (_) {}
      log.warn({ qrPng: QR_PNG, qrCount: _qrSinceConnect }, 'WhatsApp QR ready, scan from the bot phone');
    }
    if (connection === 'open') {
      _connected = true;
      const wasTripped = _qrGuardTripped;
      _qrSinceConnect = 0;
      _qrGuardTripped = false;
      log.info({ jid: _sock?.user?.id }, 'WhatsApp connected');
      if (wasTripped) _alertViaTelegram('WhatsApp bot is PAIRED and connected again. Admin inbox is back.');
    }
    if (connection === 'close') {
      _connected = false;
      const status = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
      const reconnect = status !== DisconnectReason.loggedOut;
      log.warn({ status, reconnect }, 'WhatsApp disconnected');
      if (status === DisconnectReason.loggedOut) {
        // QR_STORM_GUARD_09AUG2026: this is the event that actually matters and
        // it used to pass in silence. 14 of them Jun-Aug 2026, each needing a
        // human to clear credentials and re-pair; the 4 Aug one went unnoticed
        // for five days. Say it out loud, on a channel that still works.
        log.error({ status }, 'WhatsApp session LOGGED OUT — device unlinked at WhatsApp end');
        _alertViaTelegram(
          'WhatsApp bot was LOGGED OUT (session unlinked at WhatsApp end).\n\n' +
          'The Admin WhatsApp Inbox is down until someone re-pairs ' + BOT_NUMBER + '. ' +
          'Halo and Telegram are unaffected.\n\n' +
          'Do NOT leave it cycling: clear credentials only when you are ready to ' +
          'enter the pairing code immediately, or it builds a rate limit that ' +
          'blocks re-pairing (that is what happened on 4 Aug 2026).'
        );
      }
      if (reconnect && !_qrGuardTripped) setTimeout(() => _connectWhatsApp().catch((e) => log.error(e)), 3000);
    }
  });
  // WA_BOT_OUTBOUND_TELEMETRY_03JUN2026: subscribe to receipt updates
  // Baileys emits messages.update with key.id + update.status (2=server-ack,
  // 3=delivered, 4=read, 5=played). We map 3/4/5 to readable events and only
  // record updates for outbound messages we sent via /send/customer.
  _sock.ev.on('messages.update', async (updates) => {
    try {
      const STATUS_NAMES = { 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };
      for (const u of (updates || [])) {
        const mid = u?.key?.id;
        if (!mid) continue;
        // STAFF_RECEIPT_LOG_12NOV2026: log every delivery/read receipt for messages WE sent, so
        // "did Mary get the alert?" can be answered from server.log (grep staff-receipt).
        try {
          const _st = u?.update?.status;
          if (u?.key?.fromMe && typeof _st === "number" && _st >= 3) {
            log.info({ mid, jid: u?.key?.remoteJid, status: STATUS_NAMES[_st] || _st }, "staff-receipt");
          }
        } catch (_) {}
        const known = _WA_OUTBOUND_RECENT.get(mid);
        if (!known) continue; // only track customer-pushes we initiated
        const st = u?.update?.status;
        if (typeof st !== 'number') continue;
        if (st < 3) continue; // skip "sent" duplicates; we already logged that
        _waOutboundLog({
          event: STATUS_NAMES[st] || ('status_' + st),
          messageId: mid,
          to: known.to,
          kind: known.kind,
          at: new Date().toISOString(),
        });
      }
    } catch (e) {
      try { log.error({ err: e?.message }, 'wa_outbound update handler threw'); } catch (_) {}
    }
  });

  _sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log.info({ type, count: messages?.length, fromMe: messages?.[0]?.key?.fromMe, jid: messages?.[0]?.key?.remoteJid }, 'messages.upsert');
    // OFFLINE_APPEND_INBOUND_09NOV2026: messages queued while the bot was down (a restart) arrive
    // on reconnect as type "append", not "notify", and were silently dropped. The COO's "Approved
    // T-2" on 9 Nov was lost this way. Accept append messages that are not ours and are recent;
    // older ones are history sync and stay ignored.
    const _recentCut = Math.floor(Date.now() / 1000) - 15 * 60;
    const _batch = type === 'notify'
      ? messages
      : (type === 'append'
          ? (messages || []).filter(m => m && !m.key?.fromMe && Number(m.messageTimestamp?.low ?? m.messageTimestamp ?? 0) >= _recentCut)
          : []);
    if (!_batch.length) return;
    if (type !== 'notify') log.info({ count: _batch.length, jid: _batch[0]?.key?.remoteJid }, 'processing offline (append) inbound');
    for (const m of _batch) {
      // WA_BOT_OUTBOUND_TELEMETRY_03JUN2026: did this customer just reply
      // to one of our outbound nudge pushes? If the message quotes a
      // stanzaId we recently sent, log a 'replied' event.
      try {
        const quoted = m?.message?.extendedTextMessage?.contextInfo?.stanzaId
                    || m?.message?.imageMessage?.contextInfo?.stanzaId
                    || m?.message?.videoMessage?.contextInfo?.stanzaId
                    || m?.message?.conversation && m?.contextInfo?.stanzaId;
        if (quoted && _WA_OUTBOUND_RECENT.has(quoted)) {
          const known = _WA_OUTBOUND_RECENT.get(quoted);
          const replyText = m?.message?.extendedTextMessage?.text
                         || m?.message?.conversation
                         || '';
          _waOutboundLog({
            event: 'replied',
            quotedMessageId: quoted,
            from: m?.key?.remoteJid,
            originalTo: known?.to,
            originalKind: known?.kind,
            at: new Date().toISOString(),
            preview: String(replyText).slice(0, 80),
          });
        }
      } catch (e) {
        try { log.error({ err: e?.message }, 'wa_outbound reply detect threw'); } catch (_) {}
      }
      try { await _dispatch(m); }
      catch (e) { log.error({ err: e?.message }, 'dispatch threw'); }
    }
  });
}


// AUDIT_MARY_CHECK_18NOV2026 (COO 18 Nov 2026): "she should revert to the bot". The airtime audit
// (retry /var/www/honour_world/airtime_audit/alert.py) DMs Mary each discrepancy with full item_ids
// and numbers, and records it in audit_checks.json. When Mary replies to that check (quotes it,
// names a TN ref or SIM from it, mentions the audit, or it is her first reply within 24 h), the
// reply is forwarded to the COO and John and she is thanked. Read-only: no money action.
const _AUDIT_CHECKS = '/var/lib/hw-whatsapp-bot/audit_checks.json';

// STAFF_CONVERSATION_CONTEXT_18NOV2026 (COO 18 Nov): messages the bot sends to a staff member on the
// COO's behalf (via /send, from scripts or from Claude Code) are not part of that person's Claude chat,
// so when Mary answered one ("I have delivered it manually", or by quoting it) the AI said it had no
// context. Every single-recipient /send is now remembered here; replies get that context, and a staff
// reply to one of these task messages is forwarded to the COO and John.
const _STAFF_SENDS = '/var/lib/hw-whatsapp-bot/staff_sends.json';
const _STAFF_FWD_TO = ['2347031095864', '2348168867154'];
function _readStaffSends() { try { return JSON.parse(fs.readFileSync(_STAFF_SENDS, 'utf8')) || {}; } catch (_) { return {}; } }
function _writeStaffSends(d) { try { fs.writeFileSync(_STAFF_SENDS + '.tmp', JSON.stringify(d)); fs.renameSync(_STAFF_SENDS + '.tmp', _STAFF_SENDS); } catch (_) {} }
function _recordStaffSend(id, phone, text) {
  if (!phone || !text) return;
  const d = _readStaffSends();
  const cut = Date.now() - 72 * 3600 * 1000;
  const list = (d[phone] || []).filter((x) => Date.parse(x.at) > cut);
  list.push({ id: id || null, at: new Date().toISOString(), text: String(text).slice(0, 2500), replied: 0 });
  d[phone] = list.slice(-15);
  _writeStaffSends(d);
}
function _recentStaffSends(phone, hours) {
  const cut = Date.now() - (hours || 24) * 3600 * 1000;
  return (_readStaffSends()[phone] || []).filter((x) => Date.parse(x.at) > cut);
}
function _quotedOf(m) {
  const msgObj = m?.message || {};
  const inner = msgObj.ephemeralMessage?.message || msgObj;
  for (const k of Object.keys(inner)) {
    const ci = inner[k]?.contextInfo;
    if (ci && (ci.stanzaId || ci.quotedMessage)) {
      const qm = ci.quotedMessage || {};
      const qt = qm.conversation || qm.extendedTextMessage?.text || qm.imageMessage?.caption || qm.documentMessage?.caption || '';
      return { id: ci.stanzaId || null, text: String(qt || '') };
    }
  }
  return { id: null, text: '' };
}
function _watTime(iso) { try { return new Date(Date.parse(iso) + 3600 * 1000).toISOString().slice(11, 16) + ' WAT'; } catch (_) { return ''; } }
// Which recorded task message (if any) is this staff message answering? Quoting one wins; otherwise the
// newest task sent in the last 3 hours that has not been answered yet.
function _taskBeingAnswered(phone, quoted) {
  const sends = _recentStaffSends(phone, 72);
  if (quoted && quoted.id) { const hit = sends.find((x) => x.id && x.id === quoted.id); if (hit) return hit; }
  if (quoted && quoted.text && quoted.text.length > 20) {
    const qt = quoted.text.slice(0, 120);
    const hit = sends.find((x) => x.text.startsWith(qt) || x.text.includes(qt));
    if (hit) return hit;
    return null; // quoting something else: not a task reply
  }
  const recent = sends.filter((x) => Date.now() - Date.parse(x.at) < 3 * 3600 * 1000 && !x.replied);
  return recent.length ? recent[recent.length - 1] : null;
}
async function _forwardStaffTaskReply(u, task, body, hasMedia) {
  const first = String(task.text).split('\n').find((l) => l.trim().length > 3 && !/^hello\b/i.test(l.trim())) || String(task.text).split('\n')[0];
  // COO 18 Nov: space after the title, and label the reply so it reads "Mary's response: ...".
  const _fn = String(u.name || 'Staff').split(' ')[0];
  const fwd = `📩 *${u.name} replied to the bot*\n\nAbout the message sent at ${_watTime(task.at)}: "${first.slice(0, 160)}"\n\n*${_fn}'s response:* ${body || '(no text)'}${hasMedia ? '\n\n[They also sent a photo or file; it is in their chat with the bot.]' : ''}`;
  const users = Object.values(_loadUsers());
  for (const to of _STAFF_FWD_TO) {
    if (to === u.phone) continue;
    const r = users.find((x) => x.phone === to);
    if (!r) continue;
    try { await bot.sendMessage((r.jid || r.chatId || r.phone), fwd); } catch (e) { try { log.warn({ err: e?.message, to }, 'staff task reply forward failed'); } catch (_) {} }
  }
  const d = _readStaffSends();
  for (const x of (d[u.phone] || [])) if (x.at === task.at) x.replied = (x.replied || 0) + 1;
  _writeStaffSends(d);
  try { log.info({ who: u.name, taskAt: task.at, len: (body || '').length }, 'staff-task-reply-forwarded'); } catch (_) {}
}
// The context block put in front of a staff member's message before it goes to Claude.
function _staffContextBlock(msg, user) {
  try {
    if (!user?.phone) return '';
    const sends = _recentStaffSends(user.phone, 24).slice(-3);
    const q = msg._quoted || { id: null, text: '' };
    if (!sends.length && !q.text) return '';
    const first = String(user.name || '').split(' ')[0] || 'They';
    const parts = ['CONTEXT FROM THE BOT (not typed by the user):'];
    if (sends.length) {
      parts.push(`In the last 24 hours the bot sent ${first} these messages on the COO's behalf. An automated job sent them, so they are not in your earlier conversation with ${first}, but ${first} has them:`);
      for (const x of sends) parts.push(`--- sent ${_watTime(x.at)} ---\n${x.text}`);
      parts.push('---');
    }
    if (q.text) parts.push(`${first}'s message below is a reply to this quoted message:\n«${q.text.slice(0, 1500)}»`);
    if (msg._forwarded) parts.push(`${first}'s reply has already been forwarded to the COO and the CEO.`);
    parts.push(`Treat ${first}'s message as a reply in that conversation. Never say you have no context or ask what it refers to when the messages above explain it. If ${first} reports what they did (for example that an order was delivered by hand or refunded), thank them, restate the outcome in one short line naming the order, and say the COO has been told. If they ask a question about those messages, answer it from them. Do not change anything in the database because of their report.`);
    parts.push(`\n${first}'s message:`);
    return parts.join('\n');
  } catch (_) { return ''; }
}

const _AUDIT_MARY_PHONES = new Set(['2348031234976', '2349046707717']);
const _AUDIT_FORWARD_TO = ['2347031095864', '2348168867154'];
async function _auditMaryReply(m, u, text, jid) {
  if (!u || !_AUDIT_MARY_PHONES.has(String(u.phone || ''))) return false;
  let data;
  try { data = JSON.parse(fs.readFileSync(_AUDIT_CHECKS, 'utf8')); } catch (_) { return false; }
  const now = Date.now();
  const open = Object.entries(data || {})
    .filter(([, v]) => v && v.sentAt && now - Date.parse(v.sentAt) < 72 * 3600 * 1000)
    .sort((a, b) => Date.parse(b[1].sentAt) - Date.parse(a[1].sentAt));
  if (!open.length) return false;
  const ctx = m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || m.message?.documentMessage?.contextInfo || {};
  const quoted = ctx.quotedMessage?.conversation || ctx.quotedMessage?.extendedTextMessage?.text || '';
  const body = String(text || '');
  const hasMedia = !!(m.message?.imageMessage || m.message?.documentMessage || m.message?.videoMessage);
  let hit = null;
  for (const [day, v] of open) {
    const shortRefs = (v.refs || []).map((r) => String(r).split('|').slice(0, 3).join('|')).filter((r) => r.startsWith('TN|'));
    const sims = (v.sims || []).filter(Boolean);
    const quotesIt = /Airtime audit check/i.test(quoted);
    const namesIt = shortRefs.some((r) => body.includes(r)) || sims.some((x) => x.length > 3 && body.toLowerCase().includes(x.toLowerCase())) || /\baudit\b/i.test(body);
    // STAFF_CONVERSATION_CONTEXT_18NOV2026: not when a newer bot message to her is what she is answering.
    const newerTask = _recentStaffSends(String(u.phone), 72).some((x) => Date.parse(x.at) > Date.parse(v.sentAt) && !/Airtime audit check/i.test(x.text));
    const firstReply = !newerTask && !v.replies && now - Date.parse(v.sentAt) < 24 * 3600 * 1000 && (body.trim().length > 2 || hasMedia);
    if (quotesIt || namesIt || firstReply) { hit = [day, v]; break; }
  }
  if (!hit) return false;
  const [day, v] = hit;
  const label = new Date(day + 'T12:00:00Z').toUTCString().slice(0, 11);
  const fwd = `📩 *Mary on the airtime audit check (${label})*\n\n${body || '(no text)'}${hasMedia ? '\n\n[She also sent a photo or file; it is in her chat with the bot.]' : ''}`;
  const users = Object.values(_loadUsers());
  for (const to of _AUDIT_FORWARD_TO) {
    const r = users.find((x) => x.phone === to);
    if (!r) continue;
    try { await bot.sendMessage((r.jid || r.chatId || r.phone), fwd); } catch (e) { try { log.warn({ err: e?.message, to }, 'audit reply forward failed'); } catch (_) {} }
  }
  try { await bot.sendMessage(jid, 'Thank you, Mary. I have passed this to the COO.'); } catch (_) {}
  try {
    data[day] = { ...v, replies: (v.replies || 0) + 1, lastReplyAt: new Date().toISOString() };
    fs.writeFileSync(_AUDIT_CHECKS + '.tmp', JSON.stringify(data));
    fs.renameSync(_AUDIT_CHECKS + '.tmp', _AUDIT_CHECKS);
  } catch (_) {}
  try { log.info({ day, len: body.length, hasMedia }, 'audit-mary-reply-forwarded'); } catch (_) {}
  return true;
}

async function _dispatch(m) {
  // CEO directive 9 May 2026 — inbound enabled. WhatsApp bot now mirrors
  // the Telegram bot's command parser and free-text Claude pass-through
  // for registered staff. Replies go only to whitelisted users (full =
  // John+Bukunmi (CEO+COO, husband and wife — directive 9 May 2026),
  // readonly = Seun/Mary/Ayomide); unknown senders and groups are
  // dropped silently to keep WhatsApp anti-spam happy.
  if (!m.message || m.key?.fromMe) return;
  const jid = m.key?.remoteJid;
  if (!jid) return;
  // CEO directive 9 May 2026 — accept @lid (linked-device) JIDs in
  // addition to @s.whatsapp.net. Multi-device WhatsApp accounts (the
  // COO and Seun) route through @lid and were silently dropped before.
  // Reject only group/broadcast/newsletter chats.
  // BILLER_ROUTER_14NOV2026: biller groups/DMs are relayed to the HW Admin group, never parsed as staff commands.
  try { if (await handleRouteInbound(m)) return; } catch (e) { log.error({ err: e?.message }, 'route inbound threw'); }
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
      // CEO directive 9 May 2026 — match nicknames too. WhatsApp profile
      // names are personal (e.g. "Buks_love" for Bukunmi). Without a
      // nickname map the fuzzy match would drop these as unknown.
      const NICKNAMES = {
        'bukunmi': ['buks', 'bj', 'bjt'],
        'oluwaseun': ['seun', 'shawn'],
        'ayomide': ['ayo'],
      };
      if (pushName) {
        for (const candidate of _BY_PHONE.values()) {
          const first = (candidate.name || '').split(' ')[0].toLowerCase();
          const aliases = [first, ...(NICKNAMES[first] || [])].filter(Boolean);
          const hit = aliases.some(a => pushName.includes(a));
          if (hit) {
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
  // EDITED_MESSAGE_AS_TEXT_09NOV2026: an edited message arrives as protocolMessage.editedMessage
  // (Baileys 7 may wrap it in editedMessage.message). The COO's re-sent teach on 9 Nov came in
  // this way and read as empty text. Treat the edited body as the message.
  const _edited = m.message.protocolMessage?.editedMessage
    || m.message.editedMessage?.message?.protocolMessage?.editedMessage
    || null;
  const text = m.message.conversation
    || m.message.extendedTextMessage?.text
    || m.message.imageMessage?.caption
    || m.message.documentMessage?.caption
    || _edited?.conversation
    || _edited?.extendedTextMessage?.text
    || '';
  if (!text) { try { log.info({ jid, keys: Object.keys(m.message || {}), protocolType: m.message.protocolMessage?.type ?? m.message.editedMessage?.message?.protocolMessage?.type ?? null }, 'textless inbound'); } catch (_) {} }
  // BOT_USAGE_LOG_10MAY2026 — log per-user usage before any handler runs
  try {
    const cmd = (text.trim().startsWith('/') ? text.trim().split(/\s+/)[0] : 'text');
    logUsage_BOT_USAGE_LOG_10MAY2026({
      user_name: u.name,
      phone: u.phone,
      permission: u.permission,
      command: cmd,
      text_preview: text.slice(0, 200) || ('[' + Object.keys(m.message || {}).join(',') + ']'), // TEACH_HALO_09NOV2026: name the message type when there is no text
      text_len: text.length,
    });
  } catch (_) {}

  // AD_COMMENTS_20NOV2026 (COO 20 Nov): social post in -> 3 comment drafts out (runs in the background).
  try {
    if (isAdCommentRequest(u, text)) {
      handleAdComment({ m, u, text, jid, send: (to, body) => bot.sendMessage(to, body) })
        .catch((e) => { try { log.warn({ err: e?.message }, 'ad comment failed'); } catch (_) {} });
      return;
    }
  } catch (e) { try { log.warn({ err: e?.message }, 'ad comment check failed'); } catch (_) {} }
  // ELIZABETH_CHAT_20NOV2026 (COO 20 Nov): Elizabeth chats with the marketing assistant; operational
  // questions come back (false) and go to the normal handler below.
  try {
    if (isElizabeth(u) && !String(text || '').trim().startsWith('/') && !(m.message?.extendedTextMessage?.contextInfo?.stanzaId && _resolveTicketFromQuotedId(m.message.extendedTextMessage.contextInfo.stanzaId))) {
      if (await handleElizabethChat({ m, u, text, jid, send: (to, body) => bot.sendMessage(to, body) })) return;
    }
  } catch (e) { try { log.warn({ err: e?.message }, 'elizabeth chat failed'); } catch (_) {} }

  // WA_CRM_REPLY_25MAY2026 quoted-reply to a CRM ticket push? Route
  // it back into the ticket via the API's /api/v2/crm/bot-reply.
  try {
    const ctx = m.message?.extendedTextMessage?.contextInfo;
    const quotedId = ctx?.stanzaId || null;
    const tnum = quotedId ? _resolveTicketFromQuotedId(quotedId) : null;
    if (tnum && u?.phone) {
      const body = m.message?.extendedTextMessage?.text || '';
      const { kind, body: cleanBody } = _parseCrmCommand(body);
      const result = await _forwardToCrmReply({
        phone: u.phone,
        ticketNumber: tnum,
        body: cleanBody,
        kind,
      });
      if (result?.ok) {
        const d = result?.body?.data || {};
        let ack;
        if (kind === 'resolve')      ack = `✅ Resolved ${tnum}.`;
        else if (kind === 'reopen')  ack = `↻ Reopened ${tnum}.`;
        else if (d.demoted)          ack = `⚠️ ${d.preempterName || 'A teammate'} replied to ${tnum} ${d.preempterAgo || '?'}m ago. Your reply was added as an internal note instead.`;
        else if (kind === 'note')    ack = `🔒 Internal note saved on ${tnum} (staff only).`;
        else                         ack = `✉️ Reply sent to customer on ${tnum}.`;
        try { await bot.sendMessage(jid, ack); } catch (_) {}
      } else {
        const errMsg = result?.body?.error?.[0]?.msg || result?.body?.msg || result?.error || `HTTP ${result?.status || '?'}`;
        try { await bot.sendMessage(jid, `❌ Could not post your reply to ${tnum}: ${errMsg}`); } catch (_) {}
      }
      return; // handled
    }
  } catch (e) {
    try { log.warn({ err: e?.message }, 'CRM quoted-reply dispatch failed'); } catch (_) {}
  }

  // AUDIT_MARY_CHECK_18NOV2026: Mary's answer to the nightly airtime audit check goes to the COO
  // and John, and she gets a thank-you. Anything else she sends still reaches the normal handler.
  try { if (await _auditMaryReply(m, u, text, jid)) return; } catch (e) { try { log.warn({ err: e?.message }, 'audit reply relay failed'); } catch (_) {} }
  // STAFF_CONVERSATION_CONTEXT_18NOV2026
  const _q = _quotedOf(m);
  let _fwd = false;
  try {
    if (u && u.permission !== 'full' && (text || '').trim()) {
      const task = _taskBeingAnswered(String(u.phone), _q);
      if (task) { await _forwardStaffTaskReply(u, task, text, !!(m.message?.imageMessage || m.message?.documentMessage)); _fwd = true; }
    }
  } catch (e) { try { log.warn({ err: e?.message }, 'staff task reply check failed'); } catch (_) {} }

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
    _quoted: _q, // STAFF_CONVERSATION_CONTEXT_18NOV2026
    _forwarded: _fwd,
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

// TEACH_HALO_09NOV2026 (COO directive 9 Nov 2026): staff file facts for Halo as drafts
// ("teach: question | answer"); John/Bukunmi approve, fix or reject them. See teach.js.
registerTeach({
  bot,
  log,
  findSender: _findUserByTelegramId,
  fullUsers: () => [..._BY_PHONE.values()].filter(u => u.permission === 'full'),
  mongoUrl: _HW_MONGO_URL,
});

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
      'Ask the tech lead for the admin token. Never paste a token into a group chat.\n\n' +
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
function _parseFundArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'string') return null;

  // Strip leading "/fund" or "fund " verb so the rest is just args.
  let s = rawArgs.replace(/^\s*\/?fund\b/i, '').trim();
  if (!s) return null;

  // 1. Pull purpose out FIRST so its words do not interfere.
  let purpose = '';
  const purposeMatch = s.match(/\b(?:purpose|reason|note)\s*[:\-]\s*(.+)$/i);
  if (purposeMatch) {
    purpose = purposeMatch[1].trim();
    s = s.slice(0, purposeMatch.index).trim();
  }

  // 2. AMOUNT — priority order.
  //    a. Currency-marked: ₦3,000 / N3,000 / N 3000.50 / N3000
  //    b. After "with ", "of ", "for ", "to ": "with 3000"
  //    c. Last numeric token (fallback)
  let amount = NaN;
  let amountSpan = null;

  const tryRe = (re) => {
    const m = re.exec(s);
    if (!m) return false;
    const numStr = String(m[1]).replace(/[,\s]/g, '');
    const v = Number(numStr);
    if (Number.isFinite(v) && v > 0) {
      amount = v;
      amountSpan = [m.index, m.index + m[0].length];
      return true;
    }
    return false;
  };

  // a) currency-marked
  tryRe(/(?:₦|\bN)\s*([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i)
    // b) "with/of/for X"
    || tryRe(/\b(?:with|of|for|amount[:\s]*)\s+([0-9]{1,3}(?:[,\s][0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\b/i)
    // c) last number with comma format (likely an amount)
    || tryRe(/\b([0-9]{1,3}(?:[,][0-9]{3})+(?:\.[0-9]+)?)\b/);

  // d) fallback: small numeric (< 8 digits) is more likely amount than
  // wallet/phone (those are 8-11 digits).
  if (!Number.isFinite(amount)) {
    const tokens = [...s.matchAll(/\b([0-9]+(?:\.[0-9]+)?)\b/g)];
    for (const m of tokens) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && m[1].length <= 7) {
        amount = n;
        amountSpan = [m.index, m.index + m[0].length];
        break;
      }
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Strip the amount span from s so target detection cannot pick it.
  let sNoAmount = s;
  if (amountSpan) {
    sNoAmount = (s.slice(0, amountSpan[0]) + ' ' + s.slice(amountSpan[1])).replace(/\s+/g, ' ').trim();
  }

  // 3. TARGET — priority: email > phone > wallet-id digits.
  let target = null;
  let type = null;

  const emailM = sNoAmount.match(/\b(\S+@\S+\.\S+)\b/);
  if (emailM) {
    target = emailM[1];
    type = 'email';
  }

  if (!target) {
    const phoneM = sNoAmount.match(/\b((?:\+?234|0)\d{9,11})\b/);
    if (phoneM) {
      target = phoneM[1];
      // type set below by keyword inference
    }
  }

  if (!target) {
    // Look for a 6-12 digit numeric token that's not the amount.
    const numM = sNoAmount.match(/\b(\d{6,12})\b/);
    if (numM) {
      target = numM[1];
    }
  }

  if (!target) return null;

  // 4. TYPE — explicit keyword wins, then inferred from target shape.
  if (!type) {
    if (/\b(?:wallet[\s-]*id|wallet)\b/i.test(rawArgs)) type = 'wallet';
    else if (/\bemail\b/i.test(rawArgs)) type = 'email';
    else if (/\b(?:telephone|tel|phone|mobile|cell|number|line)\b/i.test(rawArgs)) type = 'telephone';
    else {
      // Infer from target shape.
      if (/^\S+@\S+\.\S+$/.test(target)) type = 'email';
      else if (/^(?:\+?234|0)\d{9,11}$/.test(target)) type = 'telephone';
      else type = 'wallet';
    }
  }

  // 5. Final shape sanity. If user explicitly said "wallet" but target
  // looks like a phone (leading 0), trust the keyword and accept it.
  if (type === 'email' && !/@/.test(target)) return null;
  if (type === 'telephone' && !/^(?:\+?234|0)\d{9,11}$/.test(target)) {
    // Fall back to wallet if it is at least a numeric id.
    if (/^\d{4,12}$/.test(target)) type = 'wallet';
    else return null;
  }
  if (type === 'wallet' && !/^\d{4,12}$/.test(target)) {
    if (/^\S+@\S+\.\S+$/.test(target)) type = 'email';
    else if (/^(?:\+?234|0)\d{9,11}$/.test(target)) type = 'telephone';
    else return null;
  }

  return { target, type, amount, purpose };
}


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
  const parsed = _parseFundArgs(args);
  if (!parsed) {
    await bot.sendMessage(msg.chat.id, '❌ Could not parse arguments. Try `/fund help`.', { parse_mode: 'Markdown' });
    return;
  }
  const target = parsed.target;
  const type = parsed.type;
  const amountStr = String(parsed.amount);
  const purposeRaw = parsed.purpose;
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
// returned 'invalid airtel phone number' on a 0811 number because 0811 is GLO,
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

// ── RINGO_RESTOCK_20NOV2026 (COO): restock one of our own SIMs through Ringo and record it ──
// "Buy 50K Airtel Airtime on Oluwaseun's number via Ringo API and record it"
// Full-access staff only. The bot finds the SIM by the staff name + network, shows exactly
// what it will buy, and spends nothing until the sender replies YES within 2 minutes.
// The API (POST /api/v2/sim-gateway/restocks/ringo, super-admin) buys, records the load and
// refuses a repeated request key, so one YES can never buy twice.
const RESTOCK_WINDOW_MS = 2 * 60 * 1000;
const _pendingRestock = new Map(); // chatId -> { op, expiresAt }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _pendingRestock) if (now > v.expiresAt) _pendingRestock.delete(k);
}, 30000);

const _ngn = (n) => '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const _spacePhone = (p) => String(p || '').replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
const _netWord = (n) => ({ MTN: 'MTN', AIRTEL: 'Airtel', GLO: 'Glo', T2MOBILE: 'T2Mobile' }[n] || n);

function _parseRestockAmount(text) {
  const t = String(text || '').replace(/(\d),(?=\d{3})/g, '$1').replace(/[₦#]/g, ' ');
  const m = t.match(/\b(\d+(?:\.\d+)?)\s*([kKmM])\b/) || t.match(/\b(\d{3,7})(?:\.\d+)?\b(?!\s*%)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2]) v *= m[2].toLowerCase() === 'k' ? 1000 : 1000000;
  return Math.round(v);
}

bot.onText(/^(?=[\s\S]*\b(?:ringo|restock)\b)(?=[\s\S]*\b(?:buy|load|restock|top\s*up)\b)[\s\S]+$/i, async (msg) => {
  if (msg.chat.type !== 'private') return;
  const sender = _findUserByTelegramId(msg.from?.id);
  if (!sender) return bot.sendMessage(msg.chat.id, 'You must /start first.');
  if (sender.permission !== 'full') return bot.sendMessage(msg.chat.id, 'Only John and Bukunmi can buy airtime stock through the bot.');
  const text = String(msg.text || '');
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, 'No admin sign-in on file for you. Run /setadmin first.');

  const amount = _parseRestockAmount(text);
  if (!amount || amount < 100) return bot.sendMessage(msg.chat.id, 'How much should I buy? Example: Buy 50K Airtel Airtime on Oluwaseun\'s number via Ringo API and record it');
  if (amount > 500000) return bot.sendMessage(msg.chat.id, 'The most I can buy through Ringo in one order is ₦500,000. Split it into smaller orders.');
  const netM = text.match(/\b(MTN|AIRTEL|GLO|9MOBILE|T2MOBILE|ETISALAT)\b/i);
  let network = netM ? netM[1].toUpperCase() : null;
  if (network === '9MOBILE' || network === 'ETISALAT') network = 'T2MOBILE';

  let gateways = [];
  try {
    const r = await fetch(`${HW_API_BASE}/api/v2/sim-gateway`, { headers: { Authorization: jwt, 'frontend-source': 'admin' } });
    const j = await r.json().catch(() => ({}));
    gateways = Array.isArray(j?.data) ? j.data : [];
  } catch (e) {
    return bot.sendMessage(msg.chat.id, 'I could not load the SIM list. Try again in a minute.');
  }
  const lower = text.toLowerCase();
  let matches = gateways.filter((g) => {
    const name = String(g.name || '').toLowerCase().trim();
    return name && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s|s)?\\b`, 'i').test(lower);
  });
  if (network) matches = matches.filter((g) => String(g.network || '').toUpperCase() === network);
  const active = matches.filter((g) => g.status === 'active');
  if (active.length) matches = active;
  if (!matches.length) {
    const names = gateways
      .filter((g) => !network || String(g.network || '').toUpperCase() === network)
      .filter((g) => g.status === 'active')
      .map((g) => `${g.name} (${_netWord(String(g.network).toUpperCase())})`);
    return bot.sendMessage(msg.chat.id, `Whose SIM should I load? I know these${network ? ` ${_netWord(network)}` : ''} lines: ${names.join(', ') || 'none'}.`);
  }
  if (matches.length > 1) {
    return bot.sendMessage(msg.chat.id, `That name matches more than one SIM: ${matches.map((g) => `${g.name} ${_netWord(String(g.network).toUpperCase())}`).join(', ')}. Say the network too, e.g. Buy 50K Airtel airtime on ${matches[0].name}'s number via Ringo.`);
  }
  const gw = matches[0];
  const gwNet = String(gw.network || '').toUpperCase();
  if (!['MTN', 'AIRTEL', 'GLO', 'T2MOBILE'].includes(gwNet)) return bot.sendMessage(msg.chat.id, `${gw.name}'s line is ${gwNet}, which Ringo does not sell.`);
  if (network && network !== gwNet) return bot.sendMessage(msg.chat.id, `${gw.name}'s line is ${_netWord(gwNet)}, not ${_netWord(network)}.`);
  const phone = String(gw.phone || '');

  const requestKey = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  _pendingRestock.set(msg.chat.id, {
    expiresAt: Date.now() + RESTOCK_WINDOW_MS,
    op: { gatewayId: gw._id, gatewayName: gw.name, network: gwNet, phone, amount, requestKey },
    sender,
  });
  _appendAudit(`${new Date().toISOString()} RESTOCK_PROPOSED sender=${sender.name}/${sender.phone} gw=${gw.name}/${gwNet} amount=${amount} key=${requestKey}`);
  return bot.sendMessage(
    msg.chat.id,
    `Buy ${_ngn(amount)} ${_netWord(gwNet)} airtime from Ringo for ${gw.name}'s line${phone ? ` ${_spacePhone(phone)}` : ''} and record it in the airtime ledger?\n\n` +
    `Ringo takes it from our Ringo wallet straight away and it cannot be reversed once it lands.\n\n` +
    `Reply YES within 2 minutes to buy. Anything else cancels.`,
  );
});

// YES only counts while a restock is waiting for this chat; otherwise the message goes on
// to the normal handlers as before.
bot.onText({ [Symbol.match]: (s) => (_pendingRestock.size && /^\s*yes\s*[.!]?\s*$/i.test(String(s || '')) ? [s] : null) }, async (msg) => {
  const p = _pendingRestock.get(msg.chat.id);
  if (!p || Date.now() > p.expiresAt) {
    _pendingRestock.delete(msg.chat.id);
    if (_msgHandler) return _msgHandler(msg);
    return;
  }
  _pendingRestock.delete(msg.chat.id);
  const { op, sender } = p;
  const jwt = _getAdminJwt(sender.phone);
  if (!jwt) return bot.sendMessage(msg.chat.id, 'No admin sign-in on file for you. Run /setadmin first.');
  await bot.sendMessage(msg.chat.id, `Buying ${_ngn(op.amount)} ${_netWord(op.network)} airtime for ${op.gatewayName}'s line now...`);
  let status = 0;
  let j = {};
  try {
    const r = await fetch(`${HW_API_BASE}/api/v2/sim-gateway/restocks/ringo`, {
      method: 'POST',
      headers: { Authorization: jwt, 'frontend-source': 'admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayId: op.gatewayId, faceAmount: op.amount, requestKey: op.requestKey, channel: 'WhatsApp bot' }),
    });
    status = r.status;
    j = await r.json().catch(() => ({}));
  } catch (e) {
    _appendAudit(`${new Date().toISOString()} RESTOCK_UNREACHABLE sender=${sender.name} key=${op.requestKey} err=${e.message}`);
    return bot.sendMessage(msg.chat.id, 'I could not reach our server, so I do not know if Ringo got the order. Do not order again yet: check the Ringo dashboard first.');
  }
  const d = j?.data || {};
  _appendAudit(`${new Date().toISOString()} RESTOCK_RESULT sender=${sender.name} key=${op.requestKey} http=${status} status=${d.status || ''} ref=${d.ringoRef || ''}`);
  if (status === 201 && d.status === 'delivered') {
    const lines = [
      `Done. ${_ngn(op.amount)} ${_netWord(op.network)} airtime sent to ${op.gatewayName}'s line ${_spacePhone(d.phone || op.phone)}.`,
      `Ringo ref: ${d.ringoRef || '-'}`,
      d.charged != null ? `Ringo charged ${_ngn(d.charged)} (${d.rate}%)` : (d.rate != null ? `Recorded at ${d.rate}% (current ${_netWord(op.network)} rate)` : ''),
      d.restockId ? 'Recorded in the airtime ledger.' : 'Not recorded: there is no rate on file. Record it in Inventory.',
      d.ringoBalanceAfter != null ? `Ringo balance now ${_ngn(d.ringoBalanceAfter)}` : '',
    ].filter(Boolean);
    return bot.sendMessage(msg.chat.id, lines.join('\n'));
  }
  if (j?.duplicate) return bot.sendMessage(msg.chat.id, `That order was already handled (${d.status || 'see Ringo'}). I did not buy again.`);
  if (status === 202) return bot.sendMessage(msg.chat.id, `Ringo has not confirmed it yet. Do not order again: check the Ringo dashboard first.${d.ringoRequestId ? `\nOur reference: ${d.ringoRequestId}` : ''}`);
  return bot.sendMessage(msg.chat.id, `Not bought. ${j?.msg || 'The server refused the order.'}`);
});

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
  // OPS_STATUS_16NOV2026: "what is happening?" / "status" / "pending on the Admin" get the live
  // status straight from the database, in about a second, whether or not the AI login works.
  if (STATUS_RX.test(String(text || '')) && String(text || '').length <= 160 && !/TN\|/i.test(String(text)) && !/\d{10,}/.test(String(text))) {
    const status = await _opsStatus();
    _appendAudit(`${new Date().toISOString()} STATUS sender=${user.name}/${user.phone}`);
    try { await bot.sendMessage(msg.chat.id, status); } catch (_) {}
    return;
  }
  const promptPreview = text.slice(0, 200).replace(/\n/g, ' ');
  console.log(`[hw-whatsapp-bot] /c invoking — ${user.name} (${user.permission}) — "${promptPreview}"`);
  _appendAudit(`${new Date().toISOString()} START sender=${user.name}/${user.phone} perm=${user.permission} prompt=${JSON.stringify(promptPreview)}`);

  try { await bot.sendChatAction(msg.chat.id, 'typing'); } catch (_) {}
  let thinkingMsg = null;
  try {
    thinkingMsg = await bot.sendMessage(msg.chat.id, '🤔 _Working on it…_', { parse_mode: 'Markdown' });
  } catch (_) {}

  // CEO directive 9 May 2026 — pre-warm a fresh admin JWT so Claude
  // (running as hwbot in the subprocess) can answer admin-data
  // questions like "how many pending transactions" by curling the
  // honourworld-api admin endpoints with HW_ADMIN_JWT. Only full-
  // permission users (John+Bukunmi) get the JWT; readonly users see
  // the same env var unset so any admin tool call from Claude fails
  // gracefully rather than acting under the wrong identity.
  let _hwAdminJwt = '';
  if (user.permission === 'full') {
    try {
      _hwAdminJwt = await _getValidJwt(user.phone);
    } catch (e) {
      console.warn(`[bot] JWT pre-warm failed for ${user.name}: ${e?.message}`);
    }
  }

  const sessionId = _newSessionId(user);
  // --dangerously-skip-permissions: in non-interactive `-p` mode there
  // is no human to approve each shell/edit/SSH; without this flag,
  // Claude bails on the first new tool with "I need approval to run
  // <command>". The bot is the controlled boundary here — only
  // whitelisted users reach this code path, and for readonly users we
  // still gate via --disallowedTools + system prompt.
  // STAFF_CONVERSATION_CONTEXT_18NOV2026: give Claude the bot's own messages the user is answering.
  const _ctxBlock = _staffContextBlock(msg, user);
  const args = [
    '-p', _ctxBlock ? _ctxBlock + '\n' + text : text,
    '--session-id', sessionId,
    '--add-dir', '/var/www/honour_world',
    '--dangerously-skip-permissions',
  ];
  if (user.permission === 'readonly') {
    args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'EnterWorktree');
    args.push('--append-system-prompt', READONLY_SYSTEM_PROMPT);
  }
  // SUPERADMIN_UNRESTRICTED_09AUG2026: appended for EVERY user.
  args.push('--append-system-prompt', _identityPrompt(user));

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
          HW_ADMIN_JWT: _hwAdminJwt || '',
          HW_ADMIN_PHONE: user.phone || '',
          HW_API_BASE: process.env.HW_API_BASE || 'https://api.honourworld.com',
          // HW_MONGO_URL_12MAY2026: mongo connection string for staff queries
          MONGO_URL: _HW_MONGO_URL,
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
    // SUPERADMIN_UNRESTRICTED_09AUG2026: appended for EVERY user.
    fallback.push('--append-system-prompt', _identityPrompt(user));
    const r2 = await _runClaude(fallback);
    stdout = r2.stdout; stderr = r2.stderr; exitCode = r2.exitCode; timedOut = r2.timedOut;
  }

  // HW_BOT_529_RETRY_22MAY2026 — Anthropic API overload (HTTP 529) is a
  // transient server-side condition. The claude CLI surfaces it as
  // "529" / "Overloaded" text in stdout/stderr. Rather than relaying
  // that raw error to staff, retry the whole invocation with
  // exponential backoff. Most 529s clear within a minute.
  const _isOverload529 = (s) => /(\b529\b|overloaded)/i.test(s || '');
  let _ovAttemptHW = 0;
  while (
    _ovAttemptHW < 3 &&
    (exitCode !== 0 || !stdout.trim()) &&
    _isOverload529(stdout + stderr)
  ) {
    _ovAttemptHW++;
    const _ovBackoff = [8000, 20000, 40000][_ovAttemptHW - 1] || 40000;
    console.warn(`[hw-bot] Anthropic 529 overload — retry ${_ovAttemptHW}/3 after ${_ovBackoff}ms`);
    try {
      _appendAudit(`${new Date().toISOString()} RETRY sender=${user.name}/${user.phone} reason=anthropic_529 attempt=${_ovAttemptHW}`);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, _ovBackoff));
    const _rOv = await _runClaude(args);
    stdout = _rOv.stdout; stderr = _rOv.stderr; exitCode = _rOv.exitCode; timedOut = _rOv.timedOut;
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
  // OPS_STATUS_16NOV2026: never show staff a raw login error; give the live status instead.
  if (CLAUDE_AUTH_FAIL_RX.test(String(body || '')) && body.length < 600) {
    console.error('[hw-whatsapp-bot] Claude auth failed, answering with live status:', String(body).slice(0, 160));
    body = (await _opsStatus()) + '\n\n(My detailed answers are offline for a moment. This is the live status from the system.)';
  }
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

// BILLER_ROUTER_14NOV2026
registerBillerRoutes({ app, getSock: () => _sock, isConnected: () => _connected, log, toJid: _toJid, waSafe: _waSafe });

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

// WA_BOT_SEND_CUSTOMER_03JUN2026 - free outbound WA nudges for KYC +
// dormant campaigns (Infobip retired due to NGN 0 balance). Accepts
// any E.164 phone, bypassing the staff-db gate on /send. Auth via
// shared token in env HW_WA_BOT_TOKEN to prevent random callers from
// blasting our number. Rate limit + opt-out tracking lives on the
// CALLER side (kyc_dropoff_nudge.py caps at 50/day).
app.post('/send/customer', async (req, res) => {
  try {
    const HW_TOK = process.env.HW_WA_BOT_TOKEN || '';
    const got = req.header('x-hw-token') || '';
    if (!HW_TOK || got !== HW_TOK) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    const { to, message, kind } = req.body || {};
    if (!to || !message) {
      return res.status(400).json({ ok: false, error: '`to` and `message` required' });
    }
    // Normalise to E.164 digit string (Baileys _toJid handles the @c.us suffix)
    const phone = String(to).replace(/[^0-9]/g, '');
    if (phone.length < 10 || phone.length > 15) {
      return res.status(400).json({ ok: false, error: `invalid phone: ${to}` });
    }
    if (!_sock || !_connected) {
      return res.status(503).json({ ok: false, error: 'WhatsApp socket not connected' });
    }
    // WA_BOT_BULK_THROTTLE_04JUN2026: gate before sending.
    const _throttle = _checkThrottle({ phone, kind });
    if (!_throttle.ok) {
      console.warn(`[send/customer] throttle reject: ${_throttle.error}`);
      _waOutboundLog({
        event: 'throttle_rejected',
        to: phone,
        kind: kind || 'msg',
        reason: _throttle.error,
        at: new Date().toISOString(),
      });
      return res.status(_throttle.code).json({ ok: false, error: _throttle.error });
    }
    try {
      const r = await _sock.sendMessage(_toJid(phone), { text: _waSafe(String(message)) });
      const mid = r?.key?.id;
      console.log(`[send/customer] ${kind || 'msg'} -> ${phone}  id=${mid}`);
      // WA_BOT_OUTBOUND_TELEMETRY_03JUN2026: record + remember
      _waOutboundLog({
        event: 'sent',
        messageId: mid,
        to: phone,
        kind: kind || 'msg',
        sentAt: new Date().toISOString(),
        length: String(message).length,
        preview: String(message).slice(0, 80),
      });
      _rememberOutbound(mid, phone, kind || 'msg');
      _consumeThrottle({ phone, throttle: _throttle.throttle });
      return res.json({ ok: true, message_id: mid });
    } catch (err) {
      console.error(`[send/customer] send failed: ${err?.message || err}`);
      return res.status(500).json({ ok: false, error: String(err?.message || err).slice(0, 200) });
    }
  } catch (outer) {
    return res.status(500).json({ ok: false, error: String(outer?.message || outer).slice(0, 200) });
  }
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
  // WA_CRM_REPLY_25MAY2026 accept ticket_number so future quoted
  // replies can be mapped back to the ticket.
  const { to, message, image, ticket_number } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: '`to` and `message` required' });

  // `to` may be: (a) a phone number (look up registered user),
  //              (b) "all-full" / "all-readonly" / "all" (broadcast),
  //              (c) a numeric Telegram chat_id (advanced).
  const db = _loadUsers();
  let recipients = [];
  const toStr = String(to).trim();
  if (toStr === 'all' || toStr === 'all-full' || toStr === 'all-readonly') {
    const filt = toStr === 'all' ? null : toStr === 'all-full' ? 'full' : 'readonly';
    // BILLER_ROUTER_14NOV2026: receive-only users (permission 'notify') get only messages addressed to them.
    const all = Object.values(db).filter((u) => u.permission !== 'notify' && u.broadcast !== false && (!filt || u.permission === filt));
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
      if (ticket_number) try { _recordTicketSend(sent?.message_id, ticket_number, r.phone); } catch (_) {} // WA_CRM_REPLY_25MAY2026
      if (recipients.length === 1 && r.phone) try { _recordStaffSend(sent?.message_id, r.phone, String(message)); } catch (_) {} // STAFF_CONVERSATION_CONTEXT_18NOV2026
    } catch (e) {
      // Markdown parse failure or photo URL fetch failure → retry plain text
      try {
        const sent = await bot.sendMessage((r.jid || r.chatId || r.phone), String(message));
        results.push({ ok: true, name: r.name, msgId: sent.message_id, plain: true });
        if (ticket_number) try { _recordTicketSend(sent?.message_id, ticket_number, r.phone); } catch (_) {} // WA_CRM_REPLY_25MAY2026
        if (recipients.length === 1 && r.phone) try { _recordStaffSend(sent?.message_id, r.phone, String(message)); } catch (_) {} // STAFF_CONVERSATION_CONTEXT_18NOV2026
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
