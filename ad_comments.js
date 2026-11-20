// AD_COMMENTS_20NOV2026 (COO 20 Nov): Elizabeth sends the bot a social post (link, pasted text after
// "comment:", or a screenshot captioned "comment") and gets 3 ready-to-post comment drafts that
// mention Honour World naturally, using today's real prices. The bot never posts anything itself.
import fs from 'fs';
import { execFile } from 'node:child_process';

const LINK_RX = /https?:\/\/(?:www\.|m\.|vm\.|vt\.|web\.)?(instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|fb\.watch|threads\.net|threads\.com|youtube\.com|youtu\.be|linkedin\.com|lnkd\.in)\/\S+/i;
const PREFIX_RX = /^\s*\/?comments?\b[:\s-]*/i;
const ELIZABETH = '2347025492523';
const LOG = '/var/lib/hw-whatsapp-bot/ad_comments.jsonl';
const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const _strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&mdash;|&ndash;/g, ',').replace(/\s+/g, ' ').trim();
async function _get(url, json) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: ctl.signal, redirect: 'follow' }); if (!r.ok) return null; return json ? await r.json() : await r.text(); }
  catch (_) { return null; } finally { clearTimeout(t); }
}
async function postText(url) {
  const host = url.toLowerCase();
  const e = encodeURIComponent(url);
  if (/x\.com|twitter\.com/.test(host)) { const j = await _get('https://publish.twitter.com/oembed?omit_script=1&url=' + e, true); if (j?.html) return { platform: 'X', text: _strip(j.html.replace(/<a [^>]*>pic\.twitter[^<]*<\/a>/g, '')), author: j.author_name }; }
  if (/tiktok\.com/.test(host)) { const j = await _get('https://www.tiktok.com/oembed?url=' + e, true); if (j?.title) return { platform: 'TikTok', text: j.title, author: j.author_name }; }
  if (/youtube\.com|youtu\.be/.test(host)) { const j = await _get('https://www.youtube.com/oembed?format=json&url=' + e, true); if (j?.title) return { platform: 'YouTube', text: j.title, author: j.author_name }; }
  const h = await _get(url, false);
  if (h) {
    const og = (p) => (h.match(new RegExp('<meta[^>]+property=["\']og:' + p + '["\'][^>]+content=["\']([^"\']*)', 'i')) || [])[1];
    const text = _strip(og('description') || og('title') || '');
    if (text && !/^(instagram|facebook|log in|threads|linkedin|sign up)$/i.test(text)) return { platform: /instagram/.test(host) ? 'Instagram' : /threads/.test(host) ? 'Threads' : /linkedin|lnkd/.test(host) ? 'LinkedIn' : 'Facebook', text, author: _strip(og('title') || '') };
  }
  return null;
}
function prices() {
  return new Promise((res) => execFile('python3', ['/var/www/honour_world/ad_prices.py'], { timeout: 20000 }, (err, out) => res(err ? '' : String(out || '').trim())));
}
function ask(prompt, imagePath) {
  const args = ['-p', prompt];
  if (imagePath) args.push('--allowedTools', 'Read');
  args.push('--disallowedTools', 'Bash', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'TodoWrite', ...(imagePath ? [] : ['Read']));
  // Runs as the unprivileged hwbot user (its own Claude login), like the biller replies. No database access.
  let st = null; try { st = fs.statSync('/home/hwbot'); } catch (_) { return Promise.resolve(null); }
  const env = { ...process.env, HOME: '/home/hwbot', USER: 'hwbot', LOGNAME: 'hwbot', NO_COLOR: '1', FORCE_COLOR: '0', MONGO_URL: '' };
  return new Promise((res) => execFile('/usr/bin/claude', args, { uid: st.uid, gid: st.gid, env, timeout: 180000, maxBuffer: 1 << 20, cwd: '/tmp' }, (err, out) => {
    const o = String(out || '').trim();
    res(err || /failed to authenticate|api error/i.test(o) ? null : o);
  }));
}
function lessons() {
  try {
    const rows = fs.readFileSync('/var/lib/hw-whatsapp-bot/watch_elizabeth_ads.jsonl', 'utf8').split('\n').filter(Boolean).slice(-40)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((r) => r && r.text && r.text.length > 15);
    return rows.slice(-15).map((r) => '- ' + r.text.slice(0, 300)).join('\n');
  } catch (_) { return ''; }
}
function clean(s) {
  return String(s || '').replace(/[–—]/g, ',').replace(/\bNGN\s?/g, '₦').replace(/https?:\/\/\S*(admin|control)\S*/gi, '').trim();
}

// Quick check, no I/O: is this message a comment request? (Elizabeth: any social link; anyone on the
// staff list: a message or screenshot caption starting with "comment".)
export function isAdCommentRequest(u, text) {
  if (!u || !text) return false;
  if (PREFIX_RX.test(text)) return true;
  return u.phone === ELIZABETH && LINK_RX.test(text);
}

export async function handleAdComment({ m, u, text, jid, send }) {
  const msg = m?.message || {};
  const isImg = !!msg.imageMessage;
  const pref = PREFIX_RX.test(text || '');
  const link = (text || '').match(LINK_RX)?.[0] || null;

  let post = null; let imagePath = null;
  if (link) post = await postText(link);
  const pasted = pref ? String(text).replace(PREFIX_RX, '').replace(LINK_RX, '').trim() : '';
  if (isImg) {
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buf = await downloadMediaMessage(m, 'buffer', {});
      imagePath = '/tmp/adc_' + (m.key?.id || Date.now()) + '.jpg'; fs.writeFileSync(imagePath, buf);
    } catch (_) { imagePath = null; }
  }
  if (!post && !pasted && !imagePath) {
    await send(jid, "I could not read that post from the link (the app hides it from bots).\n\nPlease send it one of these ways:\n1. Screenshot of the post, with the caption: comment\n2. Type: comment: then paste the post text");
    return true;
  }
  await send(jid, 'Got it 👍 Writing 3 comment options for this post...');
  const p = await prices();
  const prompt = [
    'You write short social media comments for Honour World, a Nigerian app for cheaper data, airtime, electricity bills, cable TV (DStv, GOtv, StarTimes) and exam pins (WAEC). Website honourworld.com; app "Honour World" on Play Store and App Store.',
    'A staff member (Elizabeth) will post your comment herself, by hand, under the trending post below. Write exactly 3 different options.',
    'Each comment must: react to what the post is actually about first, in a natural Nigerian voice (light pidgin is fine when the post is casual), then bring in Honour World only where it fits the topic. 1 to 3 short sentences. At most 2 emoji. No hashtags unless the platform is TikTok or Instagram (max 1).',
    'Rules you must never break: never use an em dash or en dash; write money as ₦ (never NGN or N); only quote a price from the price list below, exactly, and only if it fits; never invent a promo, discount, bonus or deadline; never say "cheapest in Nigeria" or similar; never name any supplier; never attack another brand; never reply to sad news (death, tragedy, violence) with an ad: if the post is about that, reply with only: SKIP and one line why.',
    'Match the platform: on LinkedIn write in clear professional English (no pidgin, no slang, at most 1 emoji, speak as a Nigerian business that helps people and small businesses manage everyday payments); on X keep it short and witty; on Instagram and Facebook warm and friendly.',
    (pasted && /linkedin/i.test(text || '')) ? 'This post is from LinkedIn.' : '',
    'Option 1: soft (no price, just relatable plus the name). Option 2: helpful with one real price. Option 3: playful.',
    'Output format, nothing else:\n1. <comment>\n\n2. <comment>\n\n3. <comment>',
    p ? 'Price list (today, from our live system):\n' + p : 'No price list today: do not quote any price.',
    lessons() ? 'Examples of what Elizabeth has posted (match her style):\n' + lessons() : '',
    post ? `The post (${post.platform}${post.author ? ', by ' + post.author : ''}):\n"""${post.text.slice(0, 1500)}"""` : '',
    pasted ? 'Post text as pasted:\n"""' + pasted.slice(0, 1500) + '"""' : '',
    imagePath ? 'A screenshot of the post is at ' + imagePath + '. Read it first.' : '',
  ].filter(Boolean).join('\n\n');
  const out = clean(await ask(prompt, imagePath));
  try { if (imagePath) fs.unlinkSync(imagePath); } catch (_) {}
  try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), by: u.name, link, platform: post?.platform || null, post: (post?.text || pasted || '').slice(0, 300), image: !!imagePath, out: (out || '').slice(0, 1200) }) + '\n'); } catch (_) {}
  if (!out) { await send(jid, 'Sorry, I could not write the comments just now. Please send it again in a minute.'); return true; }
  await send(jid, out + (link ? '\n\nPost: ' + link : '') + '\n\nPick one, adjust if you like, and post it yourself.');
  return true;
}
