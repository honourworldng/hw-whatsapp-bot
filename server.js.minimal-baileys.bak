// hw-whatsapp-bot — Honour World admin bot on WhatsApp via Baileys.
// CEO directive 8 May 2026. Mirrors hw-wa-bot (the Telegram bot) but
// runs on the +2348126728045 Airtel SIM. John (CEO) has full access;
// everyone else (Bukunmi, Mary, Seun, Ayomide) is read-only. Outbound
// alerts ship via the same /send shape used by hw_wa_notify.py so the
// retry-server cron scripts can route to either bot interchangeably.

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';
import qrcode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// ── Config ──────────────────────────────────────────────────────────
const HTTP_PORT = parseInt(process.env.HW_WA_HTTP_PORT || '9002', 10);
const TOKEN_FILE = process.env.HW_WA_TOKEN_FILE || '/etc/hw-whatsapp-bot.token';
const AUTH_DIR = process.env.HW_WA_AUTH_DIR || '/var/lib/hw-whatsapp-bot/auth';
const USERS_DB_PATH = process.env.HW_WA_USERS_DB || '/var/lib/hw-whatsapp-bot/wa-users.json';
const QR_FILE = '/var/log/hw-whatsapp-bot/last-qr.txt';
const QR_PNG = '/var/log/hw-whatsapp-bot/last-qr.png';
const BOT_NUMBER = process.env.HW_WA_BOT_NUMBER || '2348126728045'; // Airtel
const CLAUDE_BIN = process.env.HW_WA_CLAUDE_BIN || '/usr/bin/claude';
const PROJECT_DIR = '/var/www/hw-whatsapp-bot';
// CEO directive 8 May 2026 — prefer pairing-code over QR scan; easier
// than aiming a phone camera at a screenshot the COO has to relay.
const USE_PAIRING_CODE = String(process.env.HW_WA_PAIR_BY_CODE ?? '1') === '1';
const PAIR_CODE_FILE = '/var/log/hw-whatsapp-bot/last-pairing-code.txt';

// ── Permissions (John full, everyone else read-only) ────────────────
const USERS = [
  { name: 'John Amoo',          phone: '2348168867154', permission: 'full' },
  { name: 'Bukunmi Amoo',       phone: '2347031095864', permission: 'readonly' },
  { name: 'Oluwaseun Bamgbade', phone: '2348167993903', permission: 'readonly' },
  { name: 'Mary Adebiyi',       phone: '2349046707717', permission: 'readonly' },
  { name: 'Ayomide Oluwafemi',  phone: '2348031230718', permission: 'readonly' },
];

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// ── Phone helpers ───────────────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s|-|\+/g, '');
  if (s.startsWith('234')) return s;
  if (s.startsWith('0')) return '234' + s.slice(1);
  return s;
}
function jidFor(phone) {
  return `${normalisePhone(phone)}@s.whatsapp.net`;
}
function phoneFromJid(jid) {
  return String(jid || '').replace(/@.*$/, '').replace(/^\+/, '');
}
function userByPhone(phone) {
  const p = normalisePhone(phone);
  return USERS.find((u) => u.phone === p) || null;
}

// ── Persisted user db (chatId mapping; populated on first /start) ──
function _loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}
function _saveUsers(db) {
  fs.mkdirSync(path.dirname(USERS_DB_PATH), { recursive: true });
  fs.writeFileSync(USERS_DB_PATH, JSON.stringify(db, null, 2));
  fs.chmodSync(USERS_DB_PATH, 0o600);
}
function _registerOnFirstContact(jid) {
  const phone = phoneFromJid(jid);
  const u = userByPhone(phone);
  if (!u) return null;
  const db = _loadUsers();
  if (!db[phone]) {
    db[phone] = { name: u.name, phone: u.phone, permission: u.permission, jid, firstSeen: new Date().toISOString() };
    _saveUsers(db);
    log.info({ phone, name: u.name }, 'registered new bot user on first contact');
  } else if (db[phone].jid !== jid) {
    db[phone].jid = jid;
    _saveUsers(db);
  }
  return db[phone];
}

// ── Bearer token for /send ──────────────────────────────────────────
let BEARER = null;
function _loadBearer() {
  try {
    BEARER = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch (_) {
    BEARER = null;
  }
}
_loadBearer();

// ── Baileys socket (single connection) ──────────────────────────────
let sock = null;
let connected = false;
async function connect() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.appropriate('HW-Admin-Bot'),
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', saveCreds);
  if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const raw = await sock.requestPairingCode(BOT_NUMBER);
        const code = String(raw || '').match(/.{1,4}/g)?.join('-') || raw;
        log.warn({ code, botNumber: BOT_NUMBER }, 'WHATSAPP PAIRING CODE — enter on bot phone within 60s');
        try { fs.writeFileSync(PAIR_CODE_FILE, code + '\n', { mode: 0o600 }); } catch (_) {}
      } catch (e) {
        log.error({ err: e?.message }, 'requestPairingCode failed; falling back to QR');
      }
    }, 3000);
  }
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      // Surface the QR three ways: terminal print, plain-text file, PNG.
      try { qrTerminal.generate(qr, { small: true }); } catch (_) {}
      try { fs.writeFileSync(QR_FILE, qr + '\n', { mode: 0o600 }); } catch (_) {}
      try { await qrcode.toFile(QR_PNG, qr, { width: 512 }); fs.chmodSync(QR_PNG, 0o644); } catch (_) {}
      log.warn({ qrFile: QR_FILE, qrPng: QR_PNG }, 'WhatsApp QR ready, scan from the bot phone');
    }
    if (connection === 'open') {
      connected = true;
      log.info({ jid: sock?.user?.id }, 'WhatsApp connected');
    }
    if (connection === 'close') {
      connected = false;
      const status = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : 0;
      const shouldReconnect = status !== DisconnectReason.loggedOut;
      log.warn({ status, shouldReconnect }, 'WhatsApp disconnected');
      if (shouldReconnect) setTimeout(() => connect().catch((e) => log.error(e)), 3000);
    }
  });
  sock.ev.on('messages.upsert', onIncoming);
}

// ── Incoming-message handler (Phase 1: log + welcome only) ─────────
async function onIncoming({ messages, type }) {
  if (type !== 'notify') return;
  for (const m of messages) {
    if (!m.message || m.key.fromMe) continue;
    const jid = m.key.remoteJid;
    if (!jid?.endsWith('@s.whatsapp.net')) continue; // ignore groups/status
    const text = m.message.conversation
      || m.message.extendedTextMessage?.text
      || m.message.imageMessage?.caption
      || '';
    const phone = phoneFromJid(jid);
    const known = _registerOnFirstContact(jid);
    if (!known) {
      log.warn({ phone }, 'message from unauthorised phone, ignoring');
      continue;
    }
    log.info({ from: known.name, perm: known.permission, len: text.length }, 'msg in');
    // Phase 1 Welcome echo. Command parsing wired in next iteration.
    if (/^\/start\b/i.test(text.trim())) {
      await sock.sendMessage(jid, { text:
        `Hi ${known.name.split(' ')[0]}, you are connected to the Honour World WhatsApp admin bot.\n\n` +
        `Permission: *${known.permission}*\n\n` +
        `Command parity with the Telegram bot is being wired up. For now, please continue using the Telegram bot for /buyairtime, /buydata, /fund, etc. The COO will let you know when WhatsApp commands go live.`
      });
    } else {
      await sock.sendMessage(jid, { text:
        `Bot online. Command handling is being wired up. Please use the Telegram bot for now and the COO will switch us over when ready.`
      });
    }
  }
}

// ── HTTP /send (same shape hw_wa_notify.py uses) ────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));

function _checkAuth(req, res) {
  if (!BEARER) return true; // no token configured = open on loopback (matches hw-wa-bot)
  const h = req.headers.authorization || '';
  if (h === `Bearer ${BEARER}` || h === BEARER) return true;
  res.status(401).json({ error: 'unauthorised' });
  return false;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, connected, transport: 'whatsapp', botNumber: BOT_NUMBER });
});

app.post('/send', async (req, res) => {
  if (!_checkAuth(req, res)) return;
  if (!connected || !sock) return res.status(503).json({ error: 'WhatsApp socket not connected' });
  const { to, message, image } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: '`to` and `message` required' });
  // Resolve recipient JIDs.
  const db = _loadUsers();
  const toStr = String(to).trim();
  let recipients = [];
  if (toStr === 'all' || toStr === 'all-full' || toStr === 'all-readonly') {
    const filt = toStr === 'all' ? null : toStr === 'all-full' ? 'full' : 'readonly';
    recipients = Object.values(db).filter((u) => !filt || u.permission === filt);
  } else {
    const phone = normalisePhone(toStr);
    const found = Object.values(db).find((u) => u.phone === phone);
    if (found) recipients = [found];
    else {
      // Allow direct send to any number (e.g. customer notifications); the
      // bot will deliver via WhatsApp regardless of staff registration.
      recipients = [{ name: '(direct)', phone, jid: jidFor(phone), permission: null }];
    }
  }
  const results = [];
  for (const r of recipients) {
    try {
      let sent;
      if (image && typeof image === 'string') {
        sent = await sock.sendMessage(r.jid, { image: { url: image }, caption: String(message) });
      } else {
        sent = await sock.sendMessage(r.jid, { text: String(message) });
      }
      results.push({ ok: true, name: r.name, msgId: sent?.key?.id });
    } catch (e) {
      results.push({ ok: false, name: r.name, error: e?.message || 'send failed' });
    }
  }
  res.json({ ok: results.every((r) => r.ok), results });
});

// ── Boot ────────────────────────────────────────────────────────────
app.listen(HTTP_PORT, '127.0.0.1', () => {
  log.info({ port: HTTP_PORT }, 'HTTP /send listening on loopback');
});
connect().catch((e) => { log.error(e, 'fatal: connect'); process.exit(1); });
