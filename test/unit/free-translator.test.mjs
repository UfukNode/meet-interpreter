import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_STEPS,
  FreeTranslator,
  FreeTranslationError,
  checkFreeKey,
  cleanTranslation,
  matchCase,
  deeplBase,
  deeplCodes,
  deeplContext,
} from '../../src/offscreen/free-translator.js';
import { localTranslationState, prepareLocalTranslation } from '../../src/shared/local-translation.js';
import { setLanguage } from '../../src/shared/i18n.js';

// The messages below are checked in Turkish; i18n.test.mjs covers English.
setLanguage('tr');

const KEYS = { deeplKey: 'dl:fx', mistralKey: 'mi', groqKey: 'gq' };

function reply(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// A fake network: each host answers with the handler given, and every call is recorded.
function fakeFetch(handlers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { host, pathname } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host, pathname, body, headers: init.headers, method: init.method });
    const handler = handlers[host];
    if (!handler) throw new TypeError('Failed to fetch');
    return handler({ pathname, body, headers: init.headers, signal: init.signal });
  };
  return { fetchImpl, calls };
}

const deeplOk = ({ pathname }) =>
  pathname === '/v2/usage' ? reply(200, { character_count: 10, character_limit: 500000 }) : reply(200, { translations: [{ text: 'DeepL çevirisi. İkinci cümle.' }] });
const chatOk = (text) => ({ pathname }) => (pathname.endsWith('/models') ? reply(200, { data: [] }) : reply(200, { choices: [{ message: { content: text } }] }));

function fakeLocal({ state = 'available', text = 'Chrome çevirisi.' } = {}) {
  const created = [];
  return {
    created,
    availability: async () => state,
    create: async (opts) => {
      created.push(opts);
      return { translate: async () => text, destroy() {} };
    },
  };
}

function translator(overrides = {}) {
  let clock = 1_000_000;
  const t = new FreeTranslator({
    keys: KEYS,
    myLanguage: 'tr',
    theirLanguage: 'en',
    meetingContext: 'Launch call.',
    now: () => clock,
    ...overrides,
  });
  t.advance = (ms) => (clock += ms);
  return t;
}

async function collect(gen) {
  const out = [];
  for await (const piece of gen) out.push(piece);
  return out;
}

const job = { text: 'Hi, thanks for joining.', from: 'en', to: 'tr', history: [{ dir: 'in', source: 'Hello there.' }] };

test('the chain runs from the best service down and ends on Chrome', () => {
  assert.deepEqual(
    FREE_STEPS.map((s) => s.id),
    ['deepl', 'mistral', 'groq-gpt-oss', 'groq-qwen', 'chrome'],
  );
  assert.equal(FREE_STEPS.at(-1).key, undefined);
});

test('DeepL is used first and its answer is split into speakable sentences', async () => {
  const net = fakeFetch({ 'api-free.deepl.com': deeplOk });
  const t = translator({ fetchImpl: net.fetchImpl, local: fakeLocal() });
  const pieces = await collect(t.translate(job));
  assert.deepEqual(pieces, ['DeepL çevirisi.', 'İkinci cümle.']);
  const call = net.calls[0];
  assert.equal(call.pathname, '/v2/translate');
  assert.equal(call.headers.Authorization, 'DeepL-Auth-Key dl:fx');
  assert.deepEqual(call.body.text, ['Hi, thanks for joining.']);
  assert.equal(call.body.source_lang, 'EN');
  assert.equal(call.body.target_lang, 'TR');
  assert.equal(call.body.model_type, 'prefer_quality_optimized');
  assert.match(call.body.context, /Launch call\.\nHello there\./);
});

test('services without a key are skipped', async () => {
  const net = fakeFetch({ 'api.groq.com': chatOk('Groq çevirisi.') });
  const t = translator({ keys: { groqKey: 'gq' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate(job)), ['Groq çevirisi.']);
  assert.deepEqual(net.calls.map((c) => c.host), ['api.groq.com']);
  assert.equal(net.calls[0].body.model, 'openai/gpt-oss-120b');
  assert.equal(net.calls[0].body.include_reasoning, false);
  assert.equal(net.calls[0].body.reasoning_effort, 'low');
});

test('with no keys at all Chrome translates on this computer', async () => {
  const local = fakeLocal();
  const t = translator({ keys: {}, fetchImpl: fakeFetch({}).fetchImpl, local });
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
  assert.deepEqual(local.created, [{ sourceLanguage: 'en', targetLanguage: 'tr' }]);
});

test('when DeepL runs out of characters the call moves on and stops asking DeepL', async () => {
  let deeplCalls = 0;
  const net = fakeFetch({
    'api-free.deepl.com': () => {
      deeplCalls += 1;
      return reply(456, { message: 'Quota exceeded' });
    },
    'api.mistral.ai': chatOk('Mistral çevirisi.'),
  });
  const t = translator({ fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate(job)), ['Mistral çevirisi.']);
  t.advance(24 * 3600 * 1000);
  assert.deepEqual(await collect(t.translate(job)), ['Mistral çevirisi.']);
  assert.equal(deeplCalls, 1);
});

test('a rate-limited service rests for its Retry-After and is used again afterwards', async () => {
  let limited = true;
  const net = fakeFetch({
    'api.mistral.ai': () => (limited ? reply(429, { message: 'slow down' }, { 'retry-after': '20' }) : reply(200, { choices: [{ message: { content: 'Mistral geri döndü.' } }] })),
    'api.groq.com': chatOk('Groq çevirisi.'),
  });
  const t = translator({ keys: { mistralKey: 'mi', groqKey: 'gq' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate(job)), ['Groq çevirisi.']);
  limited = false;
  t.advance(10_000);
  assert.deepEqual(await collect(t.translate(job)), ['Groq çevirisi.']);
  t.advance(11_000);
  assert.deepEqual(await collect(t.translate(job)), ['Mistral geri döndü.']);
});

test('a rejected Groq key benches both Groq models; a quota on one model leaves the other', async () => {
  const rejected = fakeFetch({ 'api.groq.com': () => reply(401, { error: 'bad key' }) });
  const t1 = translator({ keys: { groqKey: 'gq' }, fetchImpl: rejected.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t1.translate(job)), ['Chrome çevirisi.']);
  assert.equal(rejected.calls.length, 1);

  const perModel = fakeFetch({
    'api.groq.com': ({ body }) =>
      body.model === 'openai/gpt-oss-120b' ? reply(429, { error: 'daily tokens' }) : reply(200, { choices: [{ message: { content: 'Qwen çevirisi.' } }] }),
  });
  const t2 = translator({ keys: { groqKey: 'gq' }, fetchImpl: perModel.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t2.translate(job)), ['Qwen çevirisi.']);
  const qwen = perModel.calls.at(-1).body;
  assert.equal(qwen.model, 'qwen/qwen3.8-27b');
  assert.equal(qwen.reasoning_effort, 'none');
});

test('a language DeepL refuses is skipped for that pair only', async () => {
  const net = fakeFetch({
    'api-free.deepl.com': ({ body }) => (body.source_lang === 'HI' ? reply(400, { message: 'Value for source_lang not supported' }) : deeplOk({ pathname: '/v2/translate' })),
  });
  const t = translator({ keys: { deeplKey: 'dl:fx' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate({ ...job, from: 'hi' })), ['Chrome çevirisi.']);
  const before = net.calls.length;
  await collect(t.translate({ ...job, from: 'hi' }));
  assert.equal(net.calls.length, before);
  assert.deepEqual(await collect(t.translate(job)), ['DeepL çevirisi.', 'İkinci cümle.']);
});

test('if DeepL refuses the model field, plain requests are sent from then on', async () => {
  const net = fakeFetch({
    'api-free.deepl.com': ({ body }) => (body.model_type ? reply(400, { message: 'model_type not allowed' }) : deeplOk({ pathname: '/v2/translate' })),
  });
  const t = translator({ keys: { deeplKey: 'dl:fx' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate(job)), ['DeepL çevirisi.', 'İkinci cümle.']);
  await collect(t.translate(job));
  assert.deepEqual(
    net.calls.map((c) => Boolean(c.body.model_type)),
    [true, false, false],
  );
});

test('a slow service times out and the next one answers', async () => {
  const net = fakeFetch({
    'api-free.deepl.com': ({ signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const original = FREE_STEPS[0].timeoutMs;
  FREE_STEPS[0].timeoutMs = 50;
  try {
    const t = translator({ keys: { deeplKey: 'dl:fx' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
    assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
  } finally {
    FREE_STEPS[0].timeoutMs = original;
  }
});

test('stopping the segment stops the translation instead of trying other services', async () => {
  const controller = new AbortController();
  const net = fakeFetch({
    'api-free.deepl.com': ({ signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  });
  const local = fakeLocal();
  const t = translator({ keys: { deeplKey: 'dl:fx' }, fetchImpl: net.fetchImpl, local });
  const pending = collect(t.translate({ ...job, signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  assert.equal(local.created.length, 0);
});

test('when every service fails the error is a plain sentence for the panel', async () => {
  const net = fakeFetch({ 'api-free.deepl.com': () => reply(503, 'down') });
  const t = translator({ keys: { deeplKey: 'dl:fx' }, fetchImpl: net.fetchImpl, local: null });
  await assert.rejects(collect(t.translate(job)), (err) => err instanceof FreeTranslationError && /tekrar denenecek/.test(err.message));
});

test('Chrome language packs that are not downloaded yet are not used, and checked again later', async () => {
  const local = fakeLocal({ state: 'downloadable' });
  const t = translator({ keys: {}, fetchImpl: fakeFetch({}).fetchImpl, local });
  await assert.rejects(collect(t.translate(job)), FreeTranslationError);
  assert.equal(local.created.length, 0);
  local.availability = async () => 'available';
  t.advance(16_000);
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
});

test('verify passes with Chrome ready and no keys, and explains what to do otherwise', async () => {
  const none = fakeFetch({}).fetchImpl;
  assert.deepEqual(await translator({ keys: {}, fetchImpl: none, local: fakeLocal() }).verify(), []);
  await assert.rejects(translator({ keys: {}, fetchImpl: none, local: fakeLocal({ state: 'downloadable' }) }).verify(), /hazırlanmalı/);
  await assert.rejects(translator({ keys: {}, fetchImpl: none, local: null }).verify(), /Chrome 138/);
  await assert.rejects(translator({ keys: {}, fetchImpl: none, local: fakeLocal({ state: 'unavailable' }) }).verify(), /desteklemiyor/);
});

test('verify notes a rejected key, benches a used-up DeepL and still starts on what works', async () => {
  const net = fakeFetch({
    'api-free.deepl.com': () => reply(200, { character_count: 500000, character_limit: 500000 }),
    'api.mistral.ai': () => reply(401, { message: 'Unauthorized' }),
    'api.groq.com': chatOk('ok'),
  });
  const t = translator({ fetchImpl: net.fetchImpl, local: fakeLocal({ state: 'downloadable' }) });
  const notes = await t.verify();
  assert.deepEqual(notes.map((n) => n.id), ['mistralKey']);
  assert.equal(notes[0].key, 'free.keyRejectedNote');
  assert.equal(notes[0].params.name, 'Mistral');
  net.calls.length = 0;
  await collect(t.translate(job));
  assert.deepEqual(net.calls.map((c) => c.host), ['api.groq.com']);
});

test('a new key gets a fresh chance mid-call', async () => {
  let accept = false;
  const net = fakeFetch({
    'api.groq.com': () => (accept ? reply(200, { choices: [{ message: { content: 'Groq çevirisi.' } }] }) : reply(401, { error: 'bad key' })),
  });
  const t = translator({ keys: { groqKey: 'old' }, fetchImpl: net.fetchImpl, local: fakeLocal() });
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
  accept = true;
  t.update({ keys: { groqKey: 'new' } });
  assert.deepEqual(await collect(t.translate(job)), ['Groq çevirisi.']);
  assert.equal(net.calls.at(-1).headers.Authorization, 'Bearer new');
});

test('chat requests carry the interpreter prompt, context and conversation', async () => {
  const net = fakeFetch({ 'api.mistral.ai': chatOk('"Merhaba."') });
  const t = translator({ keys: { mistralKey: 'mi' }, fetchImpl: net.fetchImpl, local: fakeLocal(), keyterms: ['Fungo'] });
  assert.deepEqual(await collect(t.translate({ ...job, concise: true })), ['Merhaba.']);
  const { body, headers } = net.calls[0];
  assert.equal(headers.Authorization, 'Bearer mi');
  assert.equal(body.model, 'mistral-medium-latest');
  assert.match(body.messages[0].content, /from English into Turkish/);
  assert.match(body.messages[0].content, /Launch call\./);
  assert.match(body.messages[0].content, /Fungo/);
  assert.match(body.messages[0].content, /falling behind/);
  assert.match(body.messages[1].content, /Counterpart: Hello there\./);
  assert.match(body.messages[1].content, /<utterance>\nHi, thanks for joining\.\n<\/utterance>/);
});

test('helpers: DeepL hosts, language codes, context and output cleanup', () => {
  assert.equal(deeplBase('abc:fx'), 'https://api-free.deepl.com');
  assert.equal(deeplBase('abc'), 'https://api.deepl.com');
  assert.deepEqual(deeplCodes('tr', 'en'), { source_lang: 'TR', target_lang: 'EN-US' });
  assert.deepEqual(deeplCodes('en', 'pt'), { source_lang: 'EN', target_lang: 'PT-BR' });
  assert.deepEqual(deeplCodes('en', 'zh'), { source_lang: 'EN', target_lang: 'ZH-HANS' });
  assert.equal(deeplContext({ meetingContext: '', history: [] }), '');
  assert.equal(cleanTranslation(' "Tamam." '), 'Tamam.');
  assert.equal(cleanTranslation('<utterance>\nTamam.\n</utterance>'), 'Tamam.');
});

test('the key test reports DeepL characters left and rejected keys', async () => {
  const net = fakeFetch({
    'api-free.deepl.com': () => reply(200, { character_count: 100000, character_limit: 500000 }),
    'api.groq.com': () => reply(401, { error: 'bad' }),
  });
  const deepl = await checkFreeKey('deeplKey', 'dl:fx', net.fetchImpl);
  assert.equal(deepl.ok, true);
  assert.match(deepl.message, /400\.000 karakter/);
  const groq = await checkFreeKey('groqKey', 'gq', net.fetchImpl);
  assert.equal(groq.ok, false);
  assert.equal(groq.rejected, true);
});

test('local translation state and preparation', async () => {
  const pairs = [
    ['en', 'tr'],
    ['tr', 'en'],
  ];
  assert.equal(await localTranslationState(pairs, undefined), 'unsupported');
  assert.equal(await localTranslationState(pairs, fakeLocal()), 'ready');
  assert.equal(await localTranslationState(pairs, fakeLocal({ state: 'downloadable' })), 'download');
  assert.equal(await localTranslationState(pairs, fakeLocal({ state: 'unavailable' })), 'unavailable');

  let state = 'downloadable';
  const progress = [];
  const api = {
    availability: async () => state,
    create: async ({ monitor }) => {
      const target = new EventTarget();
      monitor(target);
      const event = new Event('downloadprogress');
      event.loaded = 1;
      target.dispatchEvent(event);
      state = 'available';
      return { destroy() {} };
    },
  };
  assert.equal(await prepareLocalTranslation(pairs, { api, onProgress: (p) => progress.push(p) }), 'ready');
  assert.deepEqual(progress, [0.5, 1]);
});

test('a hiccup of Chrome\'s translator rests it only briefly, not for the whole call', async () => {
  let fail = true;
  const local = {
    availability: async () => 'available',
    create: async () => ({
      translate: async () => {
        if (fail) {
          fail = false;
          throw new Error('model busy');
        }
        return 'Chrome çevirisi.';
      },
    }),
  };
  const t = translator({ keys: {}, fetchImpl: fakeFetch({}).fetchImpl, local });
  await assert.rejects(collect(t.translate(job)), FreeTranslationError);
  t.advance(2000);
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
});

test('a language pack that still says downloading right after the download is waited for', async () => {
  const states = ['downloading', 'downloading', 'available'];
  const local = fakeLocal();
  local.availability = async () => states.shift() || 'available';
  const t = translator({ keys: {}, fetchImpl: fakeFetch({}).fetchImpl, local });
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
});

test('the first create after a download is retried once', async () => {
  const local = fakeLocal();
  const create = local.create;
  let first = true;
  local.create = async (opts) => {
    if (first) {
      first = false;
      throw new DOMException('not ready', 'InvalidStateError');
    }
    return create(opts);
  };
  const t = translator({ keys: {}, fetchImpl: fakeFetch({}).fetchImpl, local });
  assert.deepEqual(await collect(t.translate(job)), ['Chrome çevirisi.']);
});

test('a translation starts with a capital when the sentence did', () => {
  assert.equal(matchCase('Hello. Thank you for joining.', 'merhaba. Katıldığın için teşekkürler.', 'tr'), 'Merhaba. Katıldığın için teşekkürler.');
  assert.equal(matchCase('is it ready?', 'hazır mı?', 'tr'), 'hazır mı?');
  assert.equal(matchCase('It is fine.', 'iyi.', 'tr'), 'İyi.');
  assert.equal(matchCase('Yes.', '"evet."', 'tr'), '"Evet."');
  assert.equal(matchCase('Cuma günü saat 15.00 bizim için uygun.', '15.00 on Friday is suitable for us.', 'en'), '15.00 on Friday is suitable for us.');
  assert.equal(matchCase('3 Ekim uygun.', 'ekim 3 uygun.', 'en'), 'ekim 3 uygun.');
});
