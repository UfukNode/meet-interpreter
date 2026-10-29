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
