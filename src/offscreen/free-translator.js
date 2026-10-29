// Free translation, for people who do not pay for Claude. Services are tried from the
// best quality down, and the call moves to the next one by itself when a service is
// out of quota, rate limited, slow or failing:
//
//   DeepL API Free -> Mistral -> Groq gpt-oss-120b -> Groq Qwen -> Chrome's own translator
//
// The first four use the person's own free key and are skipped when it is not set.
// Chrome's translator runs on this computer and needs no key, so free translation
// always has somewhere to land. Which service translated a sentence is never shown.

import { buildSystemPrompt, buildUserMessage } from './translator.js';
import { SentenceSplitter, isOnlyPunctuation } from '../shared/text.js';
import { t, locale } from '../shared/i18n.js';

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Best first. A step is used when its key is set, it is not resting after a failure and
// it can translate the language pair.
export const FREE_STEPS = [
  { id: 'deepl', key: 'deeplKey', kind: 'deepl', timeoutMs: 5000 },
  {
    id: 'mistral',
    key: 'mistralKey',
    kind: 'chat',
    url: MISTRAL_URL,
    model: 'mistral-medium-latest',
    params: { max_tokens: 1024 },
    timeoutMs: 8000,
  },
  {
    id: 'groq-gpt-oss',
    key: 'groqKey',
    kind: 'chat',
    url: GROQ_URL,
    model: 'openai/gpt-oss-120b',
    params: { max_completion_tokens: 1024, reasoning_effort: 'low', include_reasoning: false },
    timeoutMs: 8000,
  },
  {
    // Groq limits each model separately, so Qwen still has quota when gpt-oss runs out.
    id: 'groq-qwen',
    key: 'groqKey',
    kind: 'chat',
    url: GROQ_URL,
    model: 'qwen/qwen3.8-27b',
    params: { max_completion_tokens: 1024, reasoning_effort: 'none' },
    timeoutMs: 8000,
  },
  { id: 'chrome', kind: 'local', timeoutMs: 5000 },
];

export const FREE_KEY_NAMES = ['deeplKey', 'mistralKey', 'groqKey'];

// Chrome's translator runs on this computer and has no quota, so after a hiccup it
// rests only briefly: with no keys it is the only step, and a long rest would leave
// every sentence in that window untranslated.
const LOCAL_REST_MS = 1500;
// Right after a language pack download Chrome can still report it as downloading, or
// say it is available while create() fails with NotSupportedError. Measured on Chrome
// 156: 4 downloads in 14 needed 1.1 to 1.6 s before create() worked.
const LOCAL_SETTLE_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY_LABELS = { deeplKey: 'DeepL', mistralKey: 'Mistral', groqKey: 'Groq' };

export function freeKeys(settings) {
  return Object.fromEntries(FREE_KEY_NAMES.map((name) => [name, String(settings?.[name] || '').trim()]));
}

export class FreeTranslationError extends Error {}

class StepError extends Error {
  // scope: 'request' (rest for a while), 'session' (key or model unusable), 'pair' (language pair unsupported)
  constructor(message, { status, retryAfterMs, scope = 'request', timeout = false } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
    this.timeout = timeout;
  }
}

// ---- DeepL --------------------------------------------------------------------------------

export function deeplBase(key) {
  return key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
}

const DEEPL_TARGET = { en: 'EN-US', pt: 'PT-BR', zh: 'ZH-HANS' };

export function deeplCodes(from, to) {
  return { source_lang: from.toUpperCase(), target_lang: DEEPL_TARGET[to] || to.toUpperCase() };
}

// DeepL's context field steers the translation without being translated or billed.
export function deeplContext({ meetingContext, history }) {
  const lines = [];
  if (meetingContext?.trim()) lines.push(meetingContext.trim());
  for (const item of history || []) lines.push(item.source);
  return lines.join('\n').slice(-1500);
}

// ---- requests -----------------------------------------------------------------------------

// The caller's signal plus a time limit. A plain timer rather than AbortSignal.timeout,
// whose timer does not keep Node (the unit tests) running.
function deadline(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
  const follow = () => controller.abort(signal.reason);
  if (signal?.aborted) follow();
  else signal?.addEventListener('abort', follow, { once: true });
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', follow);
    },
  };
}

async function failure(res) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    // no body
  }
  const seconds = Number(res.headers.get('retry-after'));
  return new StepError(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`, {
    status: res.status,
    retryAfterMs: seconds > 0 ? seconds * 1000 : undefined,
  });
}

async function send(fetchImpl, url, { method = 'POST', headers, body, signal }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new StepError('timed out', { timeout: true });
    if (err?.name === 'AbortError') throw err;
    throw new StepError(`network: ${err?.message || err}`);
  }
  if (!res.ok) throw await failure(res);
  return res.json();
}

export function chatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((part) => part?.type === 'text').map((part) => part.text).join('');
  return '';
}

export function cleanTranslation(text) {
  return String(text || '')
    .replace(/<\/?utterance>/g, '')
    .trim()
    .replace(/^(["'“”«])([\s\S]*)\1$/, '$2')
    .trim();
}

// Chrome's translator can start a sentence in lower case ("Hello." became "merhaba." in
// a real call); the translation follows the case the speaker's sentence started with.
// A sentence that starts with a number ("15.00 on Friday") is left as it is.
export function matchCase(source, translation, language) {
  const first = String(source).match(/[\p{L}\p{N}]/u)?.[0];
  if (!first || first === first.toLocaleLowerCase(language) || !translation) return translation;
  const i = translation.search(/[\p{L}\p{N}]/u);
  if (i < 0 || !/\p{L}/u.test(translation[i])) return translation;
  return translation.slice(0, i) + translation[i].toLocaleUpperCase(language) + translation.slice(i + 1);
}

function* speakable(text) {
  const splitter = new SentenceSplitter();
  for (const piece of splitter.push(text)) {
    if (!isOnlyPunctuation(piece)) yield piece;
  }
  const rest = splitter.flush();
  if (rest && !isOnlyPunctuation(rest)) yield rest;
}

// How long a step rests after a failure; Infinity means for the rest of the session.
export function restFor(err) {
  if (err.scope === 'session' || err.scope === 'pair') return Infinity;
  if (err.timeout) return 30_000;
  const status = err.status;
  if (status === 401 || status === 403) return Infinity; // key not accepted
  if (status === 456) return Infinity; // DeepL: monthly characters used up
  if (status === 429) return err.retryAfterMs ?? 30_000;
  if (status === 413) return 60_000; // over a tokens-per-minute limit
  if (status === 400 || status === 404 || status === 422) return Infinity; // model gone or request refused
  return 15_000; // network trouble or a server error
}

// ---- the translator -----------------------------------------------------------------------

export class FreeTranslator {
  constructor({ keys = {}, myLanguage, theirLanguage, meetingContext = '', keyterms = [], fetchImpl, local, log, now } = {}) {
    this.keys = { ...keys };
    this.myLanguage = myLanguage;
    this.theirLanguage = theirLanguage;
    this.meetingContext = meetingContext;
    this.keyterms = keyterms;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.local = local === undefined ? globalThis.Translator : local;
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this.restUntil = new Map(); // step id -> time
    this.badPairs = new Map(); // step id -> Set of "from>to"
    this.localTranslators = new Map();
  }

  update({ keys, meetingContext, keyterms } = {}) {
    if (keys) {
      for (const name of FREE_KEY_NAMES) {
        const value = String(keys[name] || '').trim();
        if (value === (this.keys[name] || '')) continue;
        this.keys[name] = value;
        // A new key gets a fresh chance.
        for (const step of FREE_STEPS) if (step.key === name) this.restUntil.delete(step.id);
      }
    }
    if (meetingContext !== undefined) this.meetingContext = meetingContext;
    if (keyterms) this.keyterms = keyterms;
  }

  usable(step, from, to) {
    if (step.key && !this.keys[step.key]) return false;
    if (step.kind === 'local' && typeof this.local?.create !== 'function') return false;
    if ((this.restUntil.get(step.id) || 0) > this.now()) return false;
    return !this.badPairs.get(step.id)?.has(`${from}>${to}`);
  }

  rest(step, err, from, to) {
    if (err.scope === 'pair' || (step.kind === 'deepl' && err.status === 400)) {
      if (!this.badPairs.has(step.id)) this.badPairs.set(step.id, new Set());
      this.badPairs.get(step.id).add(`${from}>${to}`);
      return;
    }
    const until = this.now() + (step.kind === 'local' ? LOCAL_REST_MS : restFor(err));
    const keyRejected = step.key && (err.status === 401 || err.status === 403);
    for (const other of FREE_STEPS) {
      if (other === step || (keyRejected && other.key === step.key)) this.restUntil.set(other.id, until);
    }
  }

  // Yields the translation in speakable pieces, like the Claude translator.
  async *translate({ text, from, to, history, concise, signal }) {
    let lastError = null;
    for (const step of FREE_STEPS) {
      if (!this.usable(step, from, to)) continue;
      const started = this.now();
      try {
        const output = await this.run(step, { text, from, to, history, concise, signal });
        this.log('info', `free translation by ${step.id} in ${this.now() - started} ms`);
        const translation = matchCase(text, cleanTranslation(output), to);
        if (translation) yield* speakable(translation);
        return;
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        lastError = err;
        this.rest(step, err, from, to);
        this.log('warn', `free translation: ${step.id} failed (${err.message}), trying the next service`);
      }
    }
    throw new FreeTranslationError(lastError ? t('free.failedNow') : t('free.noService'));
  }

  async run(step, job) {
    const limit = deadline(job.signal, step.timeoutMs);
    try {
      if (step.kind === 'deepl') return await this.deepl(job, limit.signal);
      if (step.kind === 'chat') return await this.chat(step, job, limit.signal);
      return await this.localTranslate(job, limit.signal);
    } finally {
      limit.done();
    }
  }

  async deepl({ text, from, to, history }, signal) {
    const key = this.keys.deeplKey;
    const url = `${deeplBase(key)}/v2/translate`;
    const headers = { Authorization: `DeepL-Auth-Key ${key}` };
    const body = { text: [text], ...deeplCodes(from, to) };
    const context = deeplContext({ meetingContext: this.meetingContext, history });
    if (context) body.context = context;
    // Ask for DeepL's best model; if this plan refuses the field, plain requests from now on.
    if (!this.deeplPlain) {
      try {
        const data = await send(this.fetch, url, { headers, body: { ...body, model_type: 'prefer_quality_optimized' }, signal });
        return data?.translations?.[0]?.text || '';
      } catch (err) {
        if (err.status !== 400) throw err;
        this.deeplPlain = true;
      }
    }
    const data = await send(this.fetch, url, { headers, body, signal });
    return data?.translations?.[0]?.text || '';
  }

  async chat(step, { text, from, to, history, concise }, signal) {
    const system = buildSystemPrompt({
      from,
      to,
      myLanguage: this.myLanguage,
      theirLanguage: this.theirLanguage,
      meetingContext: this.meetingContext,
      keyterms: this.keyterms,
      concise,
    });
    const user = buildUserMessage({ text, from, to, history });
    const body = {
      model: step.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      ...step.params,
    };
    const data = await send(this.fetch, step.url, { headers: { Authorization: `Bearer ${this.keys[step.key]}` }, body, signal });
    return chatText(data);
  }

  async localTranslate({ text, from, to }, signal) {
    const translator = await this.localTranslator(from, to);
    try {
      return await translator.translate(text, { signal });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new StepError('timed out', { timeout: true });
      throw err;
    }
  }

  localTranslator(from, to) {
    const id = `${from}>${to}`;
    let pending = this.localTranslators.get(id);
    if (!pending) {
      pending = (async () => {
        const options = { sourceLanguage: from, targetLanguage: to };
        let state = await this.local.availability(options);
        for (let waited = 0; state === 'downloading' && waited < LOCAL_SETTLE_MS; waited += 250) {
          await sleep(250);
          state = await this.local.availability(options);
        }
        if (state === 'unavailable') throw new StepError('language pair unavailable', { scope: 'pair' });
        // Language packs can only be downloaded after a click on a page, which this
        // document never gets: the settings page and the popup download them.
        if (state !== 'available') throw new StepError(`language pack ${state}`, { status: 'not-ready' });
        const settleUntil = Date.now() + LOCAL_SETTLE_MS;
        for (let attempt = 1; ; attempt++) {
          try {
            return await this.local.create(options);
          } catch (err) {
            if (Date.now() >= settleUntil) throw err;
            if (attempt === 1) this.log('warn', `free translation: Chrome translator not ready yet (${err?.name}), retrying`);
            await sleep(250);
          }
        }
      })();
      this.localTranslators.set(id, pending);
      pending.catch(() => this.localTranslators.delete(id));
    }
    return pending;
  }

  // Before the call: checks the keys and whether Chrome's translator is ready. Throws when
  // nothing could translate; otherwise returns notes about keys that did not work.
  async verify() {
    const pairs = [
      [this.theirLanguage, this.myLanguage],
      [this.myLanguage, this.theirLanguage],
    ];
    const notes = [];
    const checks = FREE_KEY_NAMES.filter((name) => this.keys[name]).map(async (name) => {
      const result = await checkFreeKey(name, this.keys[name], this.fetch);
      if (result.ok) return;
      if (result.exhausted || result.rejected) {
        for (const step of FREE_STEPS) if (step.key === name) this.restUntil.set(step.id, Infinity);
      }
      if (result.rejected) notes.push({ id: name, key: 'free.keyRejectedNote', params: { name: KEY_LABELS[name] } });
    });
    const local = typeof this.local?.availability === 'function'
      ? Promise.all(pairs.map(([from, to]) => this.local.availability({ sourceLanguage: from, targetLanguage: to }).catch(() => 'unavailable')))
      : Promise.resolve(null);
    const [, localStates] = await Promise.all([Promise.all(checks), local]);

    const keyed = FREE_STEPS.some((step) => step.key && this.keys[step.key] && (this.restUntil.get(step.id) || 0) <= this.now());
    const localReady = Boolean(localStates?.every((state) => state === 'available'));
    if (keyed || localReady) return notes;
    if (!localStates) {
      throw new FreeTranslationError(t('free.needChrome'));
    }
    if (localStates.includes('unavailable')) {
      throw new FreeTranslationError(t('free.pairUnsupported'));
    }
    throw new FreeTranslationError(t('free.needsPrepare'));
  }
}

// Used by the settings page test button and before a call. Never throws.
export async function checkFreeKey(name, key, fetchImpl = (...args) => fetch(...args)) {
  const limit = deadline(null, 8000);
  const signal = limit.signal;
  try {
    if (name === 'deeplKey') {
      const usage = await send(fetchImpl, `${deeplBase(key)}/v2/usage`, { method: 'GET', headers: { Authorization: `DeepL-Auth-Key ${key}` }, signal });
      const left = (usage.character_limit ?? Infinity) - (usage.character_count ?? 0);
      if (left <= 0) return { ok: false, exhausted: true, message: t('free.deeplExhausted') };
      return { ok: true, message: t('free.deeplOk', { left: Math.max(0, Math.floor(left)).toLocaleString(locale()) }) };
    }
    const url = name === 'mistralKey' ? 'https://api.mistral.ai/v1/models' : 'https://api.groq.com/openai/v1/models';
    await send(fetchImpl, url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal });
    return { ok: true, message: t('free.keyOk', { name: KEY_LABELS[name] }) };
  } catch (err) {
    const rejected = err.status === 401 || err.status === 403;
    return {
      ok: false,
      rejected,
      message: rejected
        ? t('free.keyRejected', { name: KEY_LABELS[name] })
        : t('free.keyNoResponse', { name: KEY_LABELS[name], message: err.message }),
    };
  } finally {
    limit.done();
  }
}
