// WALKIN_AUTO_DELIVER_26NOV2026 (COO 26 Nov 2026)
//
// A teammate (staff, CEO or COO) confirms a walk-in bank-transfer payment by replying
//   paid HW-W-123456
// in the HW Admin WhatsApp group, or in a DM to this bot. The bot then asks the API to
// buy the order from the Walk-in Sales wallet (walkin_deliver.py, which uses the robot's
// own admin sign-in) and answers in the same chat. The API claims each order once, so a
// second "paid" for the same order buys nothing.
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const DIR = '/var/lib/hw-whatsapp-bot';
const PAID_RE = /\bpaid\s+(HW-W-\d{6})\b/i;
// WALKIN_NATURAL_CONFIRM_26NOV2026 (COO): John replied "Payment received" to the alert and the
// bot said nothing. A reply to a walk-in alert, or any message naming the order, that says the
// money is in counts as the confirmation.
const REF_RE = /\bHW-W-\d{6}\b/i;
const CONFIRM_RE = /\b(paid|payment\s+(?:received|confirmed|seen|in)|received|confirmed?|landed|it'?s\s+in|money\s+(?:is\s+)?in|seen\s+it|deliver(?:\s+it)?)\b/i;
const NOT_RE = /\b(not|no|haven'?t|hasn'?t|didn'?t|isn'?t|yet\s+to|wrong|short|less)\b/i;
const TEAM_PHONES = ['2348168867154', '2347031095864', '2348167993903', '2348031230718', '2348031234976', '2347025492523', '2349045047820'];
const _inflight = new Set();

const _read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return d; } };
const _id = (x) => String(x || '').split('@')[0].split(':')[0];
const _text = (m) => String(m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
const _ctxInfo = (m) => m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || null;
const _quotedText = (m) => {
  const q = _ctxInfo(m)?.quotedMessage || {};
  return String(q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || '').trim();
};
function _quotesBot(m, sock) {
  const p = _id(_ctxInfo(m)?.participant);
  if (!p) return false;
  const me = [sock?.user?.id, sock?.user?.lid].filter(Boolean).map(_id);
  return me.includes(p);
}
const _spaced = (p) => String(p || '').replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');

function _teamMember(m) {
  const users = _read(DIR + '/wa-users.json', {});
  const lids = _read(DIR + '/wa-lid-map.json', {});
  const k = m.key || {};
  const isGroup = String(k.remoteJid || '').endsWith('@g.us');
  const cands = (isGroup ? [k.participant, k.participantAlt, k.participantPn, k.senderPn, m.participant] : [k.remoteJid, k.remoteJidAlt, k.senderPn])
    .filter(Boolean);
  for (const c of cands) {
    const full = String(c);
    const phone = full.endsWith('@lid') ? (lids[full] || _id(full)) : _id(full);
    if (users[phone]) return { phone, name: users[phone].name || m.pushName || phone };
    if (TEAM_PHONES.includes(phone)) return { phone, name: m.pushName || phone };
    for (const [ph, v] of Object.entries(users)) if (v && v.jid && _id(v.jid) === _id(full)) return { phone: ph, name: v.name || m.pushName || ph };
  }
  return null;
}

function _deliver(ref, who) {
  return new Promise((resolve) => {
    execFile('python3', ['/var/www/honour_world/walkin_deliver.py', ref, who], { timeout: 150000 }, (err, out) => {
      try { resolve(JSON.parse(String(out || '{}'))); } catch (_) { resolve({ ok: false, error: err ? String(err.message).slice(0, 200) : 'no answer' }); }
    });
  });
}

function _reply(ref, res) {
  const d = res?.body?.data || {};
  const err = res?.body?.error?.[0]?.msg || res?.error;
  const what = d.service ? `${d.service} for ${_spaced(d.recipient)}` : ref;
  switch (d.status) {
    case 'delivered':
      return `✅ ${ref} delivered: ${what}${d.item_id ? ` (${String(d.item_id).split('|').slice(0, 3).join('|')})` : ''}.\n\n${d.customerTold ? 'The customer has been told.' : 'Please tell the customer: the WhatsApp message did not go out.'}`;
    case 'delivery_pending':
      return `⏳ ${ref} sent: ${what}. Waiting for the network to confirm.${d.customerTold ? ' The customer has been told it is on its way.' : ''}`;
    case 'delivery_failed':
      return `❌ ${ref} was not delivered: ${d.reason || 'no reason given'}.\n\nIf the Walk-in Sales wallet needs funding, fund it, then reply "paid ${ref}" again. Otherwise deliver it by hand.`;
    case 'needs_manual':
      return `✋ ${ref}: ${d.reason || 'please deliver this one by hand.'}`;
    default:
      if (d.reason) return `ℹ️ ${ref}: ${d.reason}`;
      return `❌ ${ref}: ${err || 'I could not reach the delivery service. Try again in a minute.'}`;
  }
}

// Returns true when the message was a "paid HW-W-…" confirmation (handled here).
export async function handleWalkinPaid(m, sock, adminGroupJid, log) {
  if (!m?.message || m.key?.fromMe) return false;
  const text = _text(m);
  const jid = String(m.key?.remoteJid || '');
  const isGroup = jid.endsWith('@g.us');
  if (isGroup && jid !== adminGroupJid) return false; // only the HW Admin group, never a biller group
  const quoted = _quotedText(m);
  let ref = (text.match(PAID_RE) || [])[1] || null;
  if (!ref) {
    const named = (text.match(REF_RE) || quoted.match(REF_RE) || [])[0];
    if (named && CONFIRM_RE.test(text) && !NOT_RE.test(text)) ref = named;
  }
  if (!ref) {
    // REPLY_TO_BOT_26NOV2026 (COO): "Let the bot be responding to all its chats that we
    // respond to." A teammate replying to one of the bot's own messages in the Admin group
    // gets an answer instead of silence. DMs keep their own command and question handling.
    if (isGroup && text && _quotesBot(m, sock)) {
      const who = _teamMember(m);
      if (who) {
        const first = String(who.name).split(' ')[0];
        const named = quoted.match(REF_RE);
        const msg = named && NOT_RE.test(text)
          ? `Thank you, ${first}. I will not deliver ${named[0].toUpperCase()} until the money is in. Reply "paid ${named[0].toUpperCase()}" once it lands.`
          : `Thank you, ${first}. Noted.`;
        await sock.sendMessage(jid, { text: msg }, { quoted: m }).catch(() => {});
        return true;
      }
    }
    return false;
  }
  const who = _teamMember(m);
  if (!who) {
    if (!isGroup) await sock.sendMessage(jid, { text: 'Only the Honour World team can confirm walk-in payments.' }).catch(() => {});
    return true;
  }
  ref = String(ref).toUpperCase();
  if (_inflight.has(ref)) { await sock.sendMessage(jid, { text: `${ref} is already being delivered.` }).catch(() => {}); return true; }
  _inflight.add(ref);
  try {
    await sock.sendMessage(jid, { text: `Got it, ${String(who.name).split(' ')[0]}. Delivering ${ref} now…` }).catch(() => {});
    const res = await _deliver(ref, who.name);
    log?.info?.({ ref, who: who.name, status: res?.body?.data?.status, http: res?.http }, 'walkin-paid');
    await sock.sendMessage(jid, { text: _reply(ref, res) }).catch(() => {});
  } finally {
    _inflight.delete(ref);
  }
  return true;
}
