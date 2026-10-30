import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../../src/offscreen/tts.js';
import { describeElevenLabsError } from '../../src/shared/elevenlabs.js';
import { setLanguage } from '../../src/shared/i18n.js';

const request = { apiKey: 'k', voiceId: 'v', text: 'Merhaba.', modelId: 'eleven_flash_v2_5' };
const pcm = (...samples) => new Uint8Array(new Int16Array(samples).buffer);

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next();
  };
  return calls;
}

async function collect(gen) {
  const out = [];
  for await (const chunk of gen) out.push(...chunk);
  return out;
}

test('a dropped connection before any audio is retried', async () => {
  const calls = stubFetch([new TypeError('Failed to fetch'), () => new Response(pcm(1, 2, 3))]);
  assert.deepEqual(await collect(synthesize(request)), [1, 2, 3]);
  assert.equal(calls.length, 2);
});

test('a connection that drops after audio was heard is not repeated', async () => {
  const body = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(pcm(7, 8));
        },
        pull(c) {
          c.error(new TypeError('network error'));
        },
      }),
    );
  const calls = stubFetch([body, body]);
  const heard = [];
  await assert.rejects(async () => {
    for await (const chunk of synthesize(request)) heard.push(...chunk);
  }, /network error/);
  assert.deepEqual(heard, [7, 8]);
  assert.equal(calls.length, 1);
});

test('a request that never answers is given up and tried again', async () => {
  let calls = 0;
  globalThis.fetch = (_url, init) => {
    calls += 1;
    if (calls === 2) return Promise.resolve(new Response(pcm(4, 5)));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  };
  assert.deepEqual(await collect(synthesize({ ...request, stallMs: 30 })), [4, 5]);
  assert.equal(calls, 2);
});

test('speech that stops coming after some was heard ends with a timeout, not a hang', async () => {
  globalThis.fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(pcm(1, 2));
          init.signal.addEventListener('abort', () => c.error(init.signal.reason), { once: true });
        },
        pull: () => new Promise(() => {}),
      }),
    );
  const heard = [];
  await assert.rejects(async () => {
    for await (const chunk of synthesize({ ...request, stallMs: 30 })) heard.push(...chunk);
  }, (err) => err.name === 'TimeoutError');
  assert.deepEqual(heard, [1, 2]);
  setLanguage('en');
  assert.equal(describeElevenLabsError(new DOMException('x', 'TimeoutError')), 'ElevenLabs stopped answering.');
});

test('an aborted request is not retried', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = stubFetch([]);
  await assert.rejects(() => collect(synthesize({ ...request, signal: controller.signal })), /abort/i);
  assert.equal(calls.length, 0);
});

test('a network failure reads as a network problem, in the UI language', () => {
  setLanguage('tr');
  assert.equal(describeElevenLabsError(new TypeError('Failed to fetch')), "ElevenLabs'e ulaşılamadı (ağ sorunu).");
  setLanguage('en');
  assert.equal(describeElevenLabsError(new TypeError('Failed to fetch')), 'Could not reach ElevenLabs (network problem).');
});
