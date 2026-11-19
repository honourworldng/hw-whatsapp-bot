// TEACH_HALO_09NOV2026 (COO directive 9 Nov 2026).
//
// "Teach Halo" for staff on the admin WhatsApp bot.
//
//   teach: <question> | <answer>     any staff member: files a DRAFT (T-<n>)
//   teach list                       pending drafts
//   approve T-12                     John / Bukunmi only: publishes to Halo's knowledge base
//   fix T-12: <better answer>        John / Bukunmi only: rewrites the draft, still pending
//   reject T-12 <reason>             John / Bukunmi only
//
// Why a draft step: Halo must never learn a fact straight from a chat (a wrong
// price taught once is quoted to every customer). Staff propose, leadership
// approves, and only then does the note reach n8n.Faqs, which Halo searches.
// Storage is in teach_store.py (pymongo) so this file needs no new npm deps.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, 'teach_store.py');

export const TEACH_RE = /^(?:\/teach|teach)\b[:\s-]*([\s\S]*)$/i;
export const REVIEW_RE = /^\/?(approve|reject|fix)(?:d|ed)?\s+(t[\s-]?\d+)\b[:\s-]*([\s\S]*)$/i;

const BILLER_RE = /\b(mdollas|vtuplug|vtu ?plug|ringo|merry ?bills|autosync(?:ng)?|cash2bill|a2c)\b/i;

export function lintTeachText(text) {
  // House rules: no em/en dashes, ₦ never NGN or bare N, never a biller name.
  let t = String(text || '').replace(/[—–]/g, ',').replace(/\s+,/g, ',');
  t = t.replace(/\bNGN\s?(\d)/g, '₦$1').replace(/\bN(\d[\d,]*)\b/g, '₦$1');
  const biller = t.match(BILLER_RE);
  if (biller) return { ok: false, error: `Please do not name the supplier ("${biller[0]}"). Say "the network" or "our provider" instead.` };
  if (/\b\d{11}\b/.test(t) && /\b(nin|bvn)\b/i.test(t)) return { ok: false, error: 'That looks like an NIN or BVN. Never put a customer identity number in a note.' };
  return { ok: true, text: t.trim() };
}

const _stripQ = s => String(s || '').replace(/^\s*q(?:uestion)?\s*[:.)-]\s*/i, '').trim();
const _stripA = s => String(s || '').replace(/^\s*a(?:nswer)?\s*[:.)-]\s*/i, '').trim();

export function splitQuestionAnswer(text) {
  const r = _splitQuestionAnswer(text);
  return { question: _stripQ(r.question), answer: _stripA(r.answer) };
}

function _splitQuestionAnswer(text) {
  const t = String(text || '').trim();
  let m = t.match(/^q(?:uestion)?\s*[:.)-]\s*([\s\S]+?)\s*\ba(?:nswer)?\s*[:.)-]\s*([\s\S]+)$/i);
  if (m) return { question: m[1].trim(), answer: m[2].trim() };
  if (t.includes('|')) {
    const i = t.indexOf('|');
    return { question: t.slice(0, i).trim(), answer: t.slice(i + 1).trim() };
  }
  if (t.includes('\n')) {
    const i = t.indexOf('\n');
    const q = t.slice(0, i).trim(), a = t.slice(i + 1).trim();
    if (q && a) return { question: q, answer: a };
  }
  const qi = t.indexOf('?');
  if (qi > 8 && t.length - qi > 10) return { question: t.slice(0, qi + 1).trim(), answer: t.slice(qi + 1).trim() };
  // A plain statement: the first sentence is the topic, the whole text is the answer.
  const first = t.split(/(?<=[.!])\s+/)[0] || t;
  return { question: first.length > 150 ? first.slice(0, 147) + '...' : first, answer: t };
}

export function runStore(op, payload, mongoUrl, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn('python3', [STORE], { env: { ...process.env, MONGO_URL: mongoUrl || '' } });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'store timed out' }); } }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); } });
    child.on('close', () => {
      if (done) return; done = true; clearTimeout(timer);
      try { resolve(JSON.parse(out.trim().split('\n').pop())); }
      catch (_) { resolve({ ok: false, error: (err || out || 'empty reply from store').trim().slice(0, 300) }); }
    });
    child.stdin.end(JSON.stringify({ op, ...payload }));
  });
}

const HELP =
  '*Teach Halo* 📚\n' +
  'Send a fact Halo should know and leadership approves it before Halo uses it.\n\n' +
  'teach: <question> | <answer>\n' +
  'Example: teach: Can I buy without an account? | Yes. Tell Halo the plan and number and pay by bank transfer, no account needed.\n\n' +
  'teach list - drafts waiting for approval\n' +
  'approve T-12 - publish (John or Bukunmi)\n' +
  'fix T-12: <better answer> - rewrite a draft\n' +
  'reject T-12 <reason> - drop it';

function preview(d) {
  return `*${d.id}* (${d.status})\nQ: ${d.question}\nA: ${d.answer}`;
}

export function registerTeach({ bot, log, findSender, fullUsers, mongoUrl }) {
  const say = (chatId, text) => bot.sendMessage(chatId, text).catch(e => log?.warn?.({ err: e?.message }, 'teach reply failed'));
  const notify = async (phones, text) => {
    for (const p of phones) { try { await bot.sendMessage(p, text); } catch (e) { log?.warn?.({ err: e?.message, p }, 'teach notify failed'); } }
  };

  bot.onText(TEACH_RE, async (msg, match) => {
    const sender = findSender(msg.from?.id);
    if (!sender) return say(msg.chat.id, 'You must /start first.');
    const rest = (match[1] || '').trim();
    if (!rest || /^help$/i.test(rest)) return say(msg.chat.id, HELP);
    if (/^(list|pending|drafts)$/i.test(rest)) {
      const r = await runStore('list', {}, mongoUrl);
      if (!r.ok) return say(msg.chat.id, `Could not read drafts: ${r.error}`);
      if (!r.drafts.length) return say(msg.chat.id, 'No drafts waiting. Send "teach: <question> | <answer>" to add one.');
      return say(msg.chat.id, 'Waiting for approval:\n\n' + r.drafts.map(d => `${preview(d)}\nfrom ${d.created_by}`).join('\n\n'));
    }
    const lint = lintTeachText(rest);
    if (!lint.ok) return say(msg.chat.id, `❌ ${lint.error}`);
    const { question, answer } = splitQuestionAnswer(lint.text);
    if (answer.length < 10) return say(msg.chat.id, 'That is too short to teach. Give the full answer a customer should get.');
    const r = await runStore('create', { question, answer, raw: rest, by_name: sender.name, by_phone: sender.phone }, mongoUrl);
    if (!r.ok) return say(msg.chat.id, `❌ Could not save: ${r.error}`);
    const d = r.draft;
    let text = `📚 Saved as draft ${preview(d)}\n\nHalo will use it once John or Bukunmi approve it.`;
    if (r.similar?.length) text += '\n\nHalo already has something close:\n' + r.similar.map(s => `• ${s.question}`).join('\n');
    await say(msg.chat.id, text);
    const approvers = fullUsers().filter(u => u.phone !== sender.phone).map(u => u.phone);
    await notify(approvers,
      `📚 Teach Halo ${d.id} from ${sender.name.split(' ')[0]}:\nQ: ${d.question}\nA: ${d.answer}\n\n` +
      `Reply "approve ${d.id}", "fix ${d.id}: <better answer>" or "reject ${d.id} <reason>".`);
  });

  bot.onText(REVIEW_RE, async (msg, match) => {
    const sender = findSender(msg.from?.id);
    if (!sender) return say(msg.chat.id, 'You must /start first.');
    const action = match[1].toLowerCase();
    const id = 'T-' + match[2].replace(/\D/g, '');
    const rest = (match[3] || '').trim();
    if (sender.permission !== 'full') return say(msg.chat.id, `Only John or Bukunmi can ${action} a Halo note. Your draft stays in the queue.`);
    let r;
    if (action === 'approve') r = await runStore('approve', { id, by_name: sender.name, by_phone: sender.phone }, mongoUrl);
    else if (action === 'reject') r = await runStore('reject', { id, by_name: sender.name, by_phone: sender.phone, reason: rest }, mongoUrl);
    else {
      if (!rest) return say(msg.chat.id, `Send the new wording: fix ${id}: <better answer>  (or "fix ${id}: <question> | <answer>")`);
      const lint = lintTeachText(rest);
      if (!lint.ok) return say(msg.chat.id, `❌ ${lint.error}`);
      const fx = lint.text.includes('|') ? splitQuestionAnswer(lint.text) : { answer: lint.text };
      r = await runStore('fix', { id, by_name: sender.name, ...fx }, mongoUrl);
    }
    if (!r.ok) return say(msg.chat.id, `❌ ${r.error}${r.draft ? '\n\n' + preview(r.draft) : ''}`);
    const d = r.draft;
    if (action === 'approve') {
      await say(msg.chat.id, `✅ Live in Halo now.\n${preview(d)}`);
      if (d.created_phone && d.created_phone !== sender.phone) await notify([d.created_phone], `✅ Your Halo note ${d.id} was approved by ${sender.name.split(' ')[0]} and is live.\nQ: ${d.question}`);
    } else if (action === 'reject') {
      await say(msg.chat.id, `🗑 Rejected ${d.id}.`);
      if (d.created_phone && d.created_phone !== sender.phone) await notify([d.created_phone], `Your Halo note ${d.id} was not approved${rest ? ': ' + rest : ''}.\nQ: ${d.question}`);
    } else {
      await say(msg.chat.id, `✏️ Updated.\n${preview(d)}\n\nReply "approve ${d.id}" to publish.`);
    }
  });
}
