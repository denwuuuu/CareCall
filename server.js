// CareCall — automatic check-in calls for older relatives at set times.
// Zero dependencies (Node 20+). Places real calls through Twilio when
// config.env has Twilio keys; otherwise runs in simulation mode.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { brainName, brainReady, nextTurn, summarize } from './brain.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(DIR, 'config.env'));

const PORT = Number(process.env.PORT) || 8790;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE || path.join(DIR, 'data.json');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TW = {
  sid: process.env.TWILIO_ACCOUNT_SID || '',
  token: process.env.TWILIO_AUTH_TOKEN || '',
  from: process.env.TWILIO_FROM_NUMBER || '',
};
const LIVE = Boolean(TW.sid && TW.token && TW.from);
const GRACE_MS = 15 * 60e3;      // a slot missed by more than this (app was off) is skipped
const BUSY_DELAY_MS = 2 * 60e3;  // wait this long if the person is already on one of our calls
const SIM_RING_MS = 45e3;        // a simulated call nobody answers stops ringing after this
const ACTIVE = new Set(['calling', 'ringing', 'in-progress']);
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULT_LINES = [
  "Hi {name}! It's Daria, {caller}'s helper. {caller} asked me to call and see how you're doing. How are you feeling today?",
  'Did you get a chance to eat something yet?',
  'And did you remember to take your medicine today?',
];
const DEFAULT_GOODBYE = "Okay, that's everything. {caller} sends lots of love. Talk to you soon, bye bye!";
const ACKS = ['Okay.', 'Got it, thank you.', 'Mm-hmm, okay.', 'Alright, thanks.'];
const VOICES = {
  'Google.en-US-Chirp3-HD-Aoede': 'Aoede: warm, woman',
  'Google.en-US-Chirp3-HD-Charon': 'Charon: calm, man',
  'Polly.Joanna-Generative': 'Joanna: friendly, woman',
  'Polly.Matthew-Generative': 'Matthew: friendly, man',
};
const DEFAULT_VOICE = 'Google.en-US-Chirp3-HD-Aoede';
// What an iPhone's "Screen Unknown Callers" assistant says when it answers for them.
const SCREENER = /record your name|reason for calling|see if this person is available/i;
// A voicemail greeting that slipped past answering-machine detection.
const VOICEMAIL = /forwarded to (voicemail|an automated)|leave (me |us )?a message|after the (tone|beep)|is not available|mailbox/i;
// Seconds of quiet after they speak before it's CareCall's turn again.
const END_OF_SPEECH_S = 2;
const MAX_LINES = 12;

if (HOST !== '127.0.0.1' && !APP_PASSWORD) {
  console.error('Set APP_PASSWORD in config.env: HOST makes this app reachable from other machines.');
  process.exit(1);
}

// Twilio has to reach this app during a call to hear their answers. Unless PUBLIC_URL
// is set, a free Cloudflare quick tunnel provides that address; requests arriving
// through it may only use the /twilio/ webhooks (see route()).
let publicUrl = PUBLIC_URL;
let tunnelProc = null;
function startTunnel() {
  const bin = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((p) => fs.existsSync(p));
  if (!bin) {
    console.log('cloudflared not found (brew install cloudflared): calls will read the lines without waiting for answers.');
    return;
  }
  tunnelProc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = String(d).match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
    if (m && publicUrl !== m[0]) { publicUrl = m[0]; console.log('Call link ready:', publicUrl); }
  };
  tunnelProc.stdout.on('data', onData);
  tunnelProc.stderr.on('data', onData);
  tunnelProc.on('exit', () => {
    publicUrl = '';
    tunnelProc = null;
    console.log('Call link stopped; restarting it in 10s');
    setTimeout(startTunnel, 10e3);
  });
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { tunnelProc?.kill(); process.exit(0); });

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

// ---------- storage ----------

const empty = () => ({
  settings: { callerName: '', callerPhone: '', smsAlerts: false, voice: DEFAULT_VOICE, pushAlerts: true, ntfyTopic: '' },
  people: [], schedules: [], calls: [], flags: [], pending: [], fired: {},
});

let db = load();
// A long random ntfy topic: anyone who knows the name can read the alerts.
if (!db.settings.ntfyTopic) db.settings.ntfyTopic = 'carecall-' + crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '');

function load() {
  let text;
  try { text = fs.readFileSync(DATA_FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e;
  }
  // A parse error stops the app instead of starting over and overwriting the file.
  const data = JSON.parse(text);
  const out = { ...empty(), ...data, settings: { ...empty().settings, ...data.settings } };
  for (const s of out.schedules) {
    // Schedules saved before conversations had one message instead of lines.
    if (!s.lines) { s.lines = [s.message || DEFAULT_LINES[0]]; s.goodbye = DEFAULT_GOODBYE; delete s.message; delete s.requireKeypress; }
  }
  return out;
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

const newId = () => crypto.randomUUID().slice(0, 8);
const personById = (id) => db.people.find((p) => p.id === id);
const scheduleById = (id) => db.schedules.find((s) => s.id === id);

// ---------- time zones ----------

function partsIn(tz, date) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

function offsetMs(tz, ms) {
  const p = partsIn(tz, new Date(ms));
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Wall-clock time in `tz` -> UTC milliseconds.
function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - offsetMs(tz, guess);
  return guess - offsetMs(tz, first);
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// A schedule's times are in its own time zone if it has one, else the person's.
const scheduleTz = (s, p) => s.timezone || p.timezone;

// Every time this schedule is due between fromMs and toMs, in the schedule's time zone.
function slotsBetween(s, p, fromMs, toMs) {
  const tz = scheduleTz(s, p);
  const today = partsIn(tz, new Date(fromMs));
  const days = Math.ceil((toMs - fromMs) / 86400e3) + 1;
  const out = [];
  for (let i = -1; i <= days; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    for (const t of s.times) {
      const [hh, mm] = t.split(':').map(Number);
      const at = zonedToUtc(y, m, d, hh, mm, tz);
      if (at > fromMs && at <= toMs) out.push({ at, key: `${y}-${m}-${d} ${t}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- calls ----------

function fill(text, p) {
  const caller = db.settings.callerName || 'your family';
  return text.replaceAll('{name}', p.name).replaceAll('{caller}', caller);
}

// Live calls can wait for answers only once Twilio can reach us.
function canConverse() { return !LIVE || Boolean(publicUrl); }

function startCall({ personId, scheduleId = null, reason, chainId = null, attempt = 1 }) {
  const p = personById(personId);
  if (!p) return null;
  const s = scheduleId ? scheduleById(scheduleId) : null;
  const now = Date.now();
  if (db.calls.some((c) => c.personId === personId && ACTIVE.has(c.status))) {
    db.pending.push({ id: newId(), personId, scheduleId, reason, chainId, attempt, at: now + BUSY_DELAY_MS });
    return null;
  }
  const call = {
    id: newId(), personId, scheduleId, reason, attempt, startedAt: now,
    status: 'calling', live: LIVE,
    mode: s?.mode || 'checkin',
    lines: (s?.lines || DEFAULT_LINES).map((l) => fill(l, p)),
    goodbye: fill(s?.goodbye || DEFAULT_GOODBYE, p),
    voice: db.settings.voice || DEFAULT_VOICE,
    conversation: canConverse(),
    // Chat mode: the AI talks freely around the lines; otherwise the lines are read in order.
    smart: s?.style !== 'script' && canConverse() && brainReady(),
    turns: [],
    chat: [],
    concerns: [],
  };
  call.chainId = chainId || call.id;
  db.calls.unshift(call);
  if (LIVE) {
    placeTwilioCall(call, p).catch((e) => { finish(call, 'missed', 'Could not place the call: ' + e.message); save(); });
  } else {
    call.status = 'ringing';
  }
  return call;
}

function finish(call, outcome, detail, { noRetry = false } = {}) {
  if (!ACTIVE.has(call.status)) return;
  const now = Date.now();
  call.status = outcome;
  call.detail = detail;
  call.endedAt = now;
  const p = personById(call.personId);
  if (p && call.chat?.some((m) => m.who === 'them')) {
    const caller = db.settings.callerName || 'your family';
    // One notification per call: the summary (which covers any worries), or the
    // worries themselves if no summary could be written. Emergencies alert mid-call.
    summarize({ name: p.name, caller, chat: call.chat }).then((text) => {
      if (text) {
        call.summary = text;
        save();
        sendAlert(`CareCall: Call with ${p.name}: ${text}`);
      } else if (call.concerns.length && !call.urgent) {
        sendAlert(`CareCall: Call with ${p.name}: ${call.concerns.join(' ')}`);
      }
    });
  }
  const s = call.scheduleId ? scheduleById(call.scheduleId) : null;
  let flag = db.flags.find((f) => f.chainId === call.chainId && f.status === 'open');

  if (outcome === 'answered') {
    db.pending = db.pending.filter((j) => j.chainId !== call.chainId);
    if (flag) {
      flag.status = 'resolved';
      flag.resolvedAt = now;
      flag.resolution = `Picked up on call ${call.attempt}`;
    }
    return;
  }

  const isNew = !flag;
  if (!flag) {
    flag = {
      id: newId(), chainId: call.chainId, personId: call.personId, scheduleId: call.scheduleId,
      createdAt: now, status: 'open', missed: 0,
    };
    db.flags.unshift(flag);
  }
  flag.missed += 1;
  flag.lastReason = detail;
  flag.lastCallAt = call.startedAt;
  flag.lastAttempt = call.attempt;

  const retry = s?.retry;
  const willRetry = !noRetry && Boolean(retry?.enabled) && call.attempt < retry.maxAttempts;
  if (willRetry) {
    db.pending.push({
      id: newId(), personId: call.personId, scheduleId: call.scheduleId, reason: 'retry',
      chainId: call.chainId, attempt: call.attempt + 1, at: now + retry.afterMinutes * 60e3,
    });
  }
  if (p && !call.escalated && (isNew || !willRetry)) {
    const text = willRetry
      ? `CareCall: ${p.name} did not answer (${detail}). Calling again in ${retry.afterMinutes} min.`
      : `CareCall: ${p.name} did not answer ${flag.missed} call${flag.missed > 1 ? 's' : ''} (${detail}). No more automatic calls — open CareCall to choose the next one.`;
    sendAlert(text);
  }
}

// ---------- Twilio ----------

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

const hook = (call, kind, arg) => `${publicUrl}/twilio/${kind}/${call.id}${arg === undefined ? '' : '/' + arg}`;
const say = (call, text) => `<Say voice="${xml(call.voice)}">${xml(text)}</Say>`;
// bargeIn off: Daria finishes her sentence, then listens; a sound mid-sentence doesn't cut her off.
const listen = (call, next, seconds, inner = '') =>
  `<Gather input="speech" language="en-US" bargeIn="false" timeout="${seconds}" speechTimeout="${END_OF_SPEECH_S}" action="${xml(hook(call, 'turn', next))}" method="POST">${inner}</Gather>`;

function twimlFor(call, p) {
  if (call.mode === 'connect') {
    const caller = db.settings.callerName || 'your family';
    return `<Response>${say(call, `Hi ${p.name}! Hang on one second, I'm getting ${caller} on the line for you.`)}`
      + `<Dial callerId="${xml(TW.from)}" timeout="30">${xml(db.settings.callerPhone)}</Dial></Response>`;
  }
  if (call.conversation) {
    // Let them say "Hello?" first, the way a person would wait, then start.
    return `<Response>${listen(call, 0, 2)}<Redirect method="POST">${xml(hook(call, 'turn', 0))}</Redirect></Response>`;
  }
  // No call link: read the lines with short pauses instead of waiting for answers.
  return `<Response><Pause length="1"/>${call.lines.map((l) => say(call, l) + '<Pause length="3"/>').join('')}${say(call, call.goodbye)}</Response>`;
}

// One line of the conversation. If they stay quiet: 10s, then "take your time" + 5s,
// then ring the caller.
function turnTwiml(call, i, heard) {
  if (i >= call.lines.length) return `<Response>${say(call, call.goodbye)}<Hangup/></Response>`;
  const line = call.lines[i];
  const ack = i > 0 && heard ? ACKS[(i - 1) % ACKS.length] + ' ' : '';
  return '<Response>'
    + listen(call, i + 1, 10, say(call, ack + line))
    + listen(call, i + 1, 5, say(call, "Take your time, I'm still here."))
    + `<Redirect method="POST">${xml(hook(call, 'escalate'))}</Redirect></Response>`;
}

function escalateTwiml(call, p, { intro = '', urgent = false } = {}) {
  const caller = db.settings.callerName || 'your family';
  const phone = db.settings.callerPhone;
  call.escalated = true;
  call.urgent = urgent;
  const what = urgent ? `may need help right now: ${(call.concerns.at(-1) || 'possible emergency').replace(/[.!\s]+$/, '')}` : 'picked up but stopped answering';
  if (!phone) {
    call.escalateNote = 'add your phone number in Settings so CareCall can ring you';
  } else if (phone === TW.from) {
    call.escalateNote = "couldn't ring you: your phone is also the number CareCall calls from";
  } else {
    call.escalateNote = 'rang you';
    sendAlert(`CareCall: ${urgent ? 'URGENT: ' : ''}${p.name} ${what}. Calling you now.`);
    return `<Response>${say(call, intro || `I'm going to get ${caller} on the phone for you. One moment, okay?`)}`
      + `<Dial callerId="${xml(TW.from)}" timeout="25">${xml(phone)}</Dial>`
      + `${say(call, `${caller} couldn't pick up just now, but they'll call you back soon. Take care.`)}</Response>`;
  }
  sendAlert(`CareCall: ${urgent ? 'URGENT: ' : ''}${p.name} ${what}. Please give them a call.`);
  return `<Response>${say(call, intro || `Okay. I'll let ${caller} know to give you a call. Take care.`)}<Hangup/></Response>`;
}

// Chat mode: the AI writes each turn. Silence still gets the same 10s nudge and
// then rings the caller; if the AI can't answer in time the call falls back to the lines.
async function chatTurnTwiml(call, p, n, heard) {
  if (heard) call.chat.push({ who: 'them', text: heard });
  const out = await nextTurn({
    name: p.name, caller: db.settings.callerName || 'your family', notes: p.notes,
    topics: call.lines, goodbye: call.goodbye, chat: call.chat, flagged: call.concerns,
  });
  if (!out) {
    call.smart = false;
    return turnTwiml(call, Math.min(call.chat.filter((m) => m.who === 'you').length, call.lines.length), heard);
  }
  call.chat.push({ who: 'you', text: out.say });
  if (out.concern && !call.concerns.includes(out.concern)) call.concerns.push(out.concern);
  if (out.urgent) return escalateTwiml(call, p, { intro: out.say, urgent: true });
  if (out.end) return `<Response>${say(call, out.say)}<Hangup/></Response>`;
  return '<Response>'
    + listen(call, n + 1, 10, say(call, out.say))
    + listen(call, n + 1, 5, say(call, "Take your time, I'm still here."))
    + `<Redirect method="POST">${xml(hook(call, 'escalate'))}</Redirect></Response>`;
}

async function twilio(method, endpoint, body) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW.sid}${endpoint}`, {
    method,
    headers: { Authorization: 'Basic ' + Buffer.from(`${TW.sid}:${TW.token}`).toString('base64') },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `Twilio HTTP ${res.status}`);
  return json;
}

async function placeTwilioCall(call, p) {
  const body = new URLSearchParams({
    To: p.phone, From: TW.from, Twiml: twimlFor(call, p), Timeout: '30', MachineDetection: 'Enable',
  });
  if (publicUrl) {
    // Async detection starts talking at once instead of after a few silent seconds.
    body.append('AsyncAmd', 'true');
    body.append('AsyncAmdStatusCallback', hook(call, 'amd'));
    body.append('StatusCallback', hook(call, 'status'));
  }
  const res = await twilio('POST', '/Calls.json', body);
  call.sid = res.sid;
  if (call.status === 'calling') call.status = 'ringing';
  save();
}

let polling = false;
async function pollLiveCalls() {
  if (!LIVE || polling) return;
  polling = true;
  try {
    for (const call of db.calls.filter((c) => c.live && c.sid && ACTIVE.has(c.status))) {
      try {
        const r = await twilio('GET', `/Calls/${call.sid}.json`);
        applyTwilioStatus(call, r);
      } catch (e) {
        console.error('poll', call.sid, e.message);
      }
    }
  } finally {
    polling = false;
    save();
  }
}

function applyTwilioStatus(call, r) {
  switch (r.status) {
    case 'queued': case 'ringing': call.status = 'ringing'; return;
    case 'in-progress': call.status = 'in-progress'; return;
    case 'busy': return finish(call, 'missed', 'Line busy');
    case 'no-answer': return finish(call, 'missed', 'No answer');
    case 'canceled': return finish(call, 'missed', 'Call canceled');
    case 'failed': return finish(call, 'missed', 'Call failed (check the number)');
    case 'completed': {
      const by = r.answered_by || '';
      if (call.machine || by.startsWith('machine') || by === 'fax') return finish(call, 'missed', 'Voicemail or call screening picked up');
      if (call.urgent) return finish(call, 'missed', `Possible emergency: ${call.concerns.at(-1) || 'needed help'} (${call.escalateNote})`, { noRetry: true });
      if (call.escalated) return finish(call, 'missed', `Picked up but stopped answering (${call.escalateNote})`, { noRetry: true });
      if (call.conversation && call.mode !== 'connect' && !call.responded) return finish(call, 'missed', "Picked up but didn't say anything");
      return finish(call, 'answered', `Talked ${r.duration || 0}s`);
    }
  }
}

function pushNtfy(text) {
  return fetch(`https://ntfy.sh/${db.settings.ntfyTopic}`, {
    method: 'POST',
    body: text.replace(/^CareCall: /, ''),
    headers: { Title: 'CareCall', Priority: 'high', Tags: 'telephone_receiver' },
  }).then((r) => { if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`); });
}

function sendAlert(text) {
  console.log('[alert]', text);
  if (db.settings.pushAlerts && db.settings.ntfyTopic) pushNtfy(text).catch((e) => console.error('ntfy', e.message));
  if (!LIVE || !db.settings.smsAlerts || !db.settings.callerPhone) return;
  twilio('POST', '/Messages.json', new URLSearchParams({ To: db.settings.callerPhone, From: TW.from, Body: text }))
    .catch((e) => console.error('sms', e.message));
}

function validTwilioSignature(req, params) {
  const sig = req.headers['x-twilio-signature'];
  if (!sig || !publicUrl) return false;
  const data = publicUrl + req.url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', TW.token).update(data).digest('base64');
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- scheduler ----------

function tick() {
  const now = Date.now();
  for (const s of db.schedules) {
    if (!s.active) continue;
    const p = personById(s.personId);
    if (!p) continue;
    for (const slot of slotsBetween(s, p, now - GRACE_MS, now)) {
      const key = `${s.id}|${slot.key}`;
      if (db.fired[key]) continue;
      db.fired[key] = now;
      startCall({ personId: p.id, scheduleId: s.id, reason: 'scheduled' });
    }
  }
  const due = db.pending.filter((j) => j.at <= now);
  db.pending = db.pending.filter((j) => j.at > now);
  for (const job of due) startCall(job);

  if (!LIVE) {
    for (const c of db.calls) {
      if (c.status === 'ringing' && now - c.startedAt > SIM_RING_MS) finish(c, 'missed', 'No answer');
    }
  }
  for (const [k, t] of Object.entries(db.fired)) if (now - t > 3 * 86400e3) delete db.fired[k];
  db.calls = db.calls.slice(0, 500);
  db.flags = db.flags.filter((f, i) => f.status === 'open' || i < 200);
  save();
  pollLiveCalls();
}

// ---------- validation ----------

class BadRequest extends Error {}
const need = (ok, msg) => { if (!ok) throw new BadRequest(msg); };

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  let digits = s.replace(/\D/g, '');
  if (!s.startsWith('+') && digits.length === 10) digits = '1' + digits; // assume US/Canada
  const phone = '+' + digits;
  need(/^\+[1-9]\d{7,14}$/.test(phone), 'Enter a full phone number, e.g. +1 555 123 4567');
  return phone;
}

function cleanPerson(b) {
  const name = String(b.name || '').trim();
  need(name, 'Name is required');
  const timezone = b.timezone || SERVER_TZ;
  need(validTz(timezone), 'Unknown time zone');
  return { name: name.slice(0, 80), phone: normalizePhone(b.phone), timezone, notes: String(b.notes || '').slice(0, 500) };
}

function cleanSchedule(b) {
  need(personById(b.personId), 'Pick a person');
  const times = [...new Set((b.times || []).map(String))].filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort();
  need(times.length, 'Add at least one call time');
  const days = [...new Set((b.days || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
  need(days.length, 'Pick at least one day');
  const mode = b.mode === 'connect' ? 'connect' : 'checkin';
  if (mode === 'connect') need(db.settings.callerPhone, 'Add your own phone number in Settings first — "connect" calls ring you after they answer');
  const r = b.retry || {};
  const afterMinutes = Math.round(Number(r.afterMinutes));
  const maxAttempts = Math.round(Number(r.maxAttempts));
  if (r.enabled) {
    need(afterMinutes >= 1 && afterMinutes <= 1440, 'Retry wait must be 1–1440 minutes');
    need(maxAttempts >= 2 && maxAttempts <= 10, 'Total calls must be 2–10');
  }
  const raw = Array.isArray(b.lines) ? b.lines : String(b.lines || '').split('\n');
  const lines = raw.map((l) => String(l).trim().slice(0, 300)).filter(Boolean);
  need(lines.length <= MAX_LINES, `Keep it to ${MAX_LINES} lines or fewer`);
  return {
    personId: b.personId, times, days, mode,
    lines: lines.length ? lines : DEFAULT_LINES,
    style: b.style === 'script' ? 'script' : 'chat',
    // Empty means "follow the person's time zone".
    timezone: b.timezone && validTz(b.timezone) ? b.timezone : '',
    goodbye: String(b.goodbye || '').trim().slice(0, 300) || DEFAULT_GOODBYE,
    retry: { enabled: Boolean(r.enabled), afterMinutes: afterMinutes || 15, maxAttempts: maxAttempts || 3 },
    active: b.active !== false,
  };
}

// ---------- API ----------

function stateView() {
  const now = Date.now();
  const upcoming = [];
  for (const s of db.schedules) {
    const p = personById(s.personId);
    if (!s.active || !p) continue;
    for (const slot of slotsBetween(s, p, now, now + 7 * 86400e3)) {
      upcoming.push({ at: slot.at, personId: p.id, scheduleId: s.id, reason: 'scheduled' });
    }
  }
  for (const j of db.pending) upcoming.push({ at: j.at, personId: j.personId, scheduleId: j.scheduleId, reason: j.reason, attempt: j.attempt, jobId: j.id });
  upcoming.sort((a, b) => a.at - b.at);
  const flags = db.flags
    .filter((f) => f.status === 'open' || now - (f.resolvedAt || 0) < 86400e3)
    .map((f) => ({ ...f, next: db.pending.filter((j) => j.chainId === f.chainId).sort((a, b) => a.at - b.at)[0] || null }));
  return {
    mode: LIVE ? 'live' : 'simulation',
    conversation: canConverse(),
    brain: brainReady(),
    brainName: brainName(),
    voices: VOICES,
    defaults: { lines: DEFAULT_LINES, goodbye: DEFAULT_GOODBYE },
    serverTz: SERVER_TZ,
    now,
    settings: db.settings,
    people: db.people,
    schedules: db.schedules,
    flags,
    calls: db.calls.slice(0, 100),
    upcoming: upcoming.slice(0, 20),
  };
}

function flagAction(flag, action, body) {
  need(flag, 'Alert not found');
  const chainJobs = () => db.pending.filter((j) => j.chainId === flag.chainId);
  const nextAttempt = (flag.lastAttempt || 1) + 1;
  if (action === 'resolve') {
    db.pending = db.pending.filter((j) => j.chainId !== flag.chainId);
    Object.assign(flag, { status: 'resolved', resolvedAt: Date.now(), resolution: 'Marked OK by you' });
  } else if (action === 'reschedule') {
    const at = Number(body.at);
    need(at > Date.now() - 60e3, 'Pick a time in the future');
    const keep = chainJobs()[0];
    db.pending = db.pending.filter((j) => j.chainId !== flag.chainId);
    db.pending.push({
      id: newId(), personId: flag.personId, scheduleId: flag.scheduleId, reason: 'retry',
      chainId: flag.chainId, attempt: keep?.attempt || nextAttempt, at,
    });
  } else if (action === 'stop-retrying') {
    db.pending = db.pending.filter((j) => j.chainId !== flag.chainId);
  } else if (action === 'call-now') {
    db.pending = db.pending.filter((j) => j.chainId !== flag.chainId);
    startCall({ personId: flag.personId, scheduleId: flag.scheduleId, reason: 'retry', chainId: flag.chainId, attempt: nextAttempt });
  } else {
    need(false, 'Unknown action');
  }
}

async function readBody(req, form = false) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 100_000) throw new BadRequest('Request too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (form) return Object.fromEntries(new URLSearchParams(text));
  return text ? JSON.parse(text) : {};
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [, b64 = ''] = (req.headers.authorization || '').split(' ');
  const pass = Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(pass).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // Twilio webhooks: authenticated by Twilio's signature instead of the app password.
  if (parts[0] === 'twilio' && method === 'POST') {
    const body = await readBody(req, true);
    if (!validTwilioSignature(req, body)) return send(res, 403, 'Bad signature', 'text/plain');
    const call = db.calls.find((c) => c.id === parts[2]);
    const p = call && personById(call.personId);
    if (!call || !p) return send(res, 200, '<Response><Hangup/></Response>', 'text/xml');
    const kind = parts[1];
    if (kind === 'status') {
      if (call.sid === body.CallSid) applyTwilioStatus(call, { status: body.CallStatus, answered_by: body.AnsweredBy, duration: body.CallDuration });
      save();
      return send(res, 204, '', 'text/plain');
    }
    if (kind === 'amd') {
      const by = body.AnsweredBy || '';
      if (by.startsWith('machine') || by === 'fax') {
        call.machine = true;
        twilio('POST', `/Calls/${call.sid}.json`, new URLSearchParams({ Status: 'completed' })).catch((e) => console.error('hangup', e.message));
      }
      save();
      return send(res, 204, '', 'text/plain');
    }
    if (kind === 'turn') {
      const i = Math.max(0, Number(parts[3]) || 0);
      const heard = String(body.SpeechResult || '').trim();
      if (i === 0 && heard && SCREENER.test(heard) && !call.screened) {
        // iPhone call screening: say who's calling so they can pick up, then wait for them.
        call.screened = true;
        save();
        const caller = db.settings.callerName || 'family';
        return send(res, 200, `<Response>${say(call, `Hi, this is Daria, calling with ${caller}'s check-in for ${p.name}.`)}`
          + `${listen(call, 0, 20)}<Redirect method="POST">${xml(hook(call, 'turn', 0))}</Redirect></Response>`, 'text/xml');
      }
      if (heard && VOICEMAIL.test(heard) && !call.responded) {
        call.machine = true;
        save();
        return send(res, 200, '<Response><Hangup/></Response>', 'text/xml');
      }
      const real = heard && !SCREENER.test(heard) ? heard : '';
      if (real) call.responded = true;
      if (call.smart) {
        const twiml = await chatTurnTwiml(call, p, i, real);
        save();
        return send(res, 200, twiml, 'text/xml');
      }
      if (real && i > 0) call.turns.push({ q: call.lines[i - 1], a: real });
      save();
      return send(res, 200, turnTwiml(call, i, real), 'text/xml');
    }
    if (kind === 'escalate') {
      const twiml = escalateTwiml(call, p);
      save();
      return send(res, 200, twiml, 'text/xml');
    }
    return send(res, 404, 'Not found', 'text/plain');
  }

  // Anything else that came in through the tunnel is refused unless a password is set.
  const remote = req.headers['cf-ray'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (remote && !APP_PASSWORD) return send(res, 403, 'Forbidden', 'text/plain');

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="CareCall"' });
    return res.end('Password required');
  }

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(DIR, 'public', 'index.html')), 'text/html; charset=utf-8');
  }
  if (parts[0] !== 'api') return send(res, 404, { error: 'Not found' });
  if (method === 'GET' && parts[1] === 'state') return send(res, 200, stateView());
  need(method === 'POST' || method === 'PUT' || method === 'DELETE', 'Bad method');

  const body = method === 'DELETE' ? {} : await readBody(req);
  const [, kind, id, action] = parts;

  if (kind === 'settings') {
    db.settings = {
      callerName: String(body.callerName || '').trim().slice(0, 80),
      callerPhone: body.callerPhone ? normalizePhone(body.callerPhone) : '',
      smsAlerts: Boolean(body.smsAlerts),
      voice: VOICES[body.voice] ? body.voice : DEFAULT_VOICE,
      pushAlerts: Boolean(body.pushAlerts),
      ntfyTopic: db.settings.ntfyTopic,
    };
  } else if (kind === 'people') {
    if (method === 'POST') db.people.push({ id: newId(), ...cleanPerson(body) });
    else {
      const p = personById(id);
      need(p, 'Person not found');
      if (method === 'PUT') Object.assign(p, cleanPerson(body));
      else {
        db.people = db.people.filter((x) => x.id !== id);
        db.schedules = db.schedules.filter((s) => s.personId !== id);
        db.pending = db.pending.filter((j) => j.personId !== id);
        db.flags = db.flags.filter((f) => f.personId !== id);
      }
    }
  } else if (kind === 'schedules') {
    // Times that already passed don't fire the moment you save.
    const skipPast = (s) => {
      for (const slot of slotsBetween(s, personById(s.personId), Date.now() - GRACE_MS, Date.now())) db.fired[`${s.id}|${slot.key}`] = Date.now();
    };
    if (method === 'POST') {
      const s = { id: newId(), createdAt: Date.now(), ...cleanSchedule(body) };
      skipPast(s);
      db.schedules.push(s);
    } else {
      const s = scheduleById(id);
      need(s, 'Schedule not found');
      if (method === 'PUT') { Object.assign(s, cleanSchedule({ ...s, ...body })); skipPast(s); }
      else {
        db.schedules = db.schedules.filter((x) => x.id !== id);
        db.pending = db.pending.filter((j) => j.scheduleId !== id);
      }
    }
  } else if (kind === 'test-alert') {
    await pushNtfy('Test from CareCall. Missed-call alerts will show up here.').catch((e) => need(false, 'Could not reach ntfy: ' + e.message));
  } else if (kind === 'call-now') {
    need(personById(body.personId), 'Person not found');
    const s = body.scheduleId ? scheduleById(body.scheduleId) : null;
    const call = startCall({ personId: body.personId, scheduleId: s?.id || null, reason: 'manual' });
    need(call, 'They are already on a call — trying again in 2 minutes');
  } else if (kind === 'flags') {
    flagAction(db.flags.find((f) => f.id === id), action, body);
  } else if (kind === 'pending' && method === 'DELETE') {
    db.pending = db.pending.filter((j) => j.id !== id);
  } else if (kind === 'sim') {
    need(!LIVE, 'Simulation is off — real calls are being placed');
    const call = db.calls.find((c) => c.id === id);
    need(call && ACTIVE.has(call.status), 'That call is no longer ringing');
    if (body.action === 'answer') {
      call.turns = call.lines.map((q) => ({ q, a: '(simulated answer)' }));
      finish(call, 'answered', 'Picked up and answered every question');
    } else if (body.action === 'silent') {
      call.escalated = true;
      call.escalateNote = db.settings.callerPhone ? 'rang you' : 'add your phone number in Settings so CareCall can ring you';
      finish(call, 'missed', `Picked up but stopped answering (${call.escalateNote})`, { noRetry: true });
    } else if (body.action === 'voicemail') finish(call, 'missed', 'Voicemail or call screening picked up');
    else if (body.action === 'busy') finish(call, 'missed', 'Line busy');
    else finish(call, 'missed', 'No answer');
  } else {
    need(false, 'Not found');
  }
  save();
  return send(res, 200, stateView());
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof BadRequest || e instanceof SyntaxError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`CareCall on http://${HOST}:${PORT} — ${LIVE ? 'LIVE: placing real calls via Twilio' : 'SIMULATION: no real calls'}`);
});
if (LIVE && !PUBLIC_URL && process.env.TUNNEL !== 'off') startTunnel();
tick();
setInterval(tick, 15e3);
