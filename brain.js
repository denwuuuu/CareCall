// The chat brain: an AI model decides what CareCall says next on a call, from the
// conversation so far, the caller's check-in topics and notes about the person.
// Groq (free tier) when GROQ_API_KEY is set, Claude when an Anthropic key is set;
// BRAIN=groq|claude picks one explicitly.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const GROQ_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const groqModel = () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const TURN_TIMEOUT_MS = 9000; // Twilio gives up on a webhook after 15s
const MAX_TURNS = 8;

let client;
// Created on first use, after server.js has loaded config.env.
function getClient() {
  if (client === undefined) {
    try { client = new Anthropic({ maxRetries: 0 }); } catch { client = null; }
  }
  return client;
}

function provider() {
  const chosen = (process.env.BRAIN || '').toLowerCase();
  if (chosen) return chosen;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'claude';
  return '';
}

export function brainReady() {
  const p = provider();
  if (p === 'groq') return Boolean(process.env.GROQ_API_KEY);
  if (p === 'claude') return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) && Boolean(getClient());
  return false;
}

export function brainName() {
  if (!brainReady()) return '';
  return provider() === 'groq' ? `Groq (${groqModel()})` : `Claude (${MODEL})`;
}

// Groq's OpenAI-compatible chat endpoint. Returns the reply text, or throws.
async function groqChat(system, user, { json, timeout }) {
  const model = groqModel();
  const res = await fetch(`${GROQ_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: 800,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${body.error?.message || 'request failed'}`);
  return body.choices?.[0]?.message?.content || '';
}

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    say: { type: 'string', description: 'Exactly what to speak next, as plain spoken words.' },
    end: { type: 'boolean', description: 'True if this turn says goodbye and the call should hang up.' },
    concern: { type: 'string', description: 'A short note for the caller if something worrying came up this turn, otherwise empty.' },
    urgent: { type: 'boolean', description: 'True only for a possible emergency that needs the caller right now.' },
  },
  required: ['say', 'end', 'concern', 'urgent'],
  additionalProperties: false,
};

function systemPrompt({ name, caller, notes, topics, goodbye }) {
  return `You are Daria, the voice on a friendly daily check-in phone call to ${name}, an older person. ${caller} set up these calls because they care about ${name} and can't always call themselves. Your words are spoken aloud by a text-to-speech voice, and ${name}'s replies reach you through speech recognition, so they may have small transcription mistakes.

How to talk:
- Sound like a warm, patient person on the phone, not a survey. Short sentences, simple words, one question at a time, usually one or two sentences per turn.
- Really respond to what ${name} says: react briefly and warmly before moving on. Keep small talk short: at most one or two light exchanges in the whole call (their day, the weather, family), then get back to the check-in. Don't stretch the call out.
- Speak only plain words: no emojis, lists, stage directions or brackets.
- Your name is Daria. In your first turn, say hello and that it's Daria, ${caller}'s helper. Never pretend to be ${caller} or a human. If asked who you are, say you're Daria, a helper ${caller} set up to check in on them, and that ${caller} reads how the call went.
- Do not give medical advice, diagnoses or medication instructions. Be caring and suggest they mention it to their doctor or to ${caller}.

What to cover, woven naturally into the conversation rather than read as a list:
${topics.map((t) => `- ${t}`).join('\n')}

Notes from ${caller} about ${name}: ${notes || 'none'}

Flags:
- concern: if ${name} mentions something ${caller} should know (pain, feeling unwell, sadness or loneliness, a missed medicine, not eating, a fall, confusion, needing something), write one short plain note for ${caller}. Otherwise leave it empty. Don't repeat a concern you already flagged.
- urgent: true only for a possible emergency (a fall they can't get up from, chest pain, trouble breathing, signs of a stroke, they say they need help now). Then say, calmly, that you're getting ${caller} on the phone right away and that if it's an emergency they should hang up and call 911.

Ending: once the topics are covered and the chat winds down, or if ${name} wants to go, say a warm goodbye in the spirit of "${goodbye}" and set end to true. Aim to finish within about ${MAX_TURNS - 2} turns.

Latency-sensitive; begin your visible answer immediately.`;
}

const JSON_INSTRUCTION = '\n\nReply with only a JSON object with exactly these keys: "say" (string: what to speak next), "end" (boolean: true if this turn says goodbye), "concern" (string: a short note for the caller, or empty), "urgent" (boolean: true only for a possible emergency).';

function transcriptText(name, chat) {
  if (!chat.length) return `${name} just picked up and hasn't said anything yet.`;
  return chat.map((m) => `${m.who === 'them' ? name : 'You'}: ${m.text}`).join('\n');
}

// Returns {say, end, concern, urgent}, or null when Claude isn't available or
// doesn't answer in time (the caller then falls back to the scripted lines).
export async function nextTurn(ctx) {
  if (!brainReady()) return null;
  const turn = ctx.chat.filter((m) => m.who === 'you').length + 1;
  const flagged = ctx.flagged?.length
    ? `\n\nAlready flagged this call (leave concern empty unless it's something new): ${ctx.flagged.join('; ')}`
    : '';
  const user = `The call so far:\n${transcriptText(ctx.name, ctx.chat)}${flagged}\n\nThis is your turn ${turn} of at most ${MAX_TURNS}. Write your next turn.`;
  if (provider() === 'groq') {
    try {
      const out = JSON.parse(await groqChat(systemPrompt(ctx) + JSON_INSTRUCTION, user, { json: true, timeout: TURN_TIMEOUT_MS }));
      return cleanTurn(out, turn);
    } catch (e) {
      console.error('brain:', e.message);
      return null;
    }
  }
  const c = getClient();
  try {
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: TURN_SCHEMA } },
      system: systemPrompt(ctx),
      messages: [{ role: 'user', content: user }],
    }, { timeout: TURN_TIMEOUT_MS });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    return cleanTurn(JSON.parse(text), turn);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error('brain: the Anthropic API key was rejected');
    else if (e instanceof Anthropic.RateLimitError) console.error('brain: rate limited');
    else if (e instanceof Anthropic.APIError) console.error(`brain: API error ${e.status}: ${e.message}`);
    else console.error('brain:', e.message);
    return null;
  }
}

function cleanTurn(out, turn) {
  const say = String(out?.say || '').trim();
  if (!say) return null;
  return { say, end: out.end === true || turn >= MAX_TURNS, concern: String(out.concern || '').trim(), urgent: out.urgent === true };
}

// A two-sentence summary of the call for the caller.
export async function summarize({ name, caller, chat }) {
  if (!brainReady() || !chat.some((m) => m.who === 'them')) return '';
  const system = `You summarize a check-in phone call with ${name} for ${caller}, who loves them. Write at most two short, plain sentences: how ${name} seemed and anything ${caller} should follow up on. No preamble.`;
  if (provider() === 'groq') {
    try {
      return (await groqChat(system, transcriptText(name, chat), { json: false, timeout: 30000 })).trim();
    } catch (e) {
      console.error('brain summary:', e.message);
      return '';
    }
  }
  const c = getClient();
  try {
    const response = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: transcriptText(name, chat) }],
    }, { timeout: 30000 });
    if (response.stop_reason === 'refusal') return '';
    return response.content.find((b) => b.type === 'text')?.text?.trim() || '';
  } catch (e) {
    console.error('brain summary:', e.message);
    return '';
  }
}
