import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ScribeRealtime } from '../../src/offscreen/stt.js';

class FakeSocket {
  static OPEN = 1;
  static all = [];
  constructor(url) {
    this.url = new URL(url);
    this.readyState = 1;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
  }
  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const last = () => FakeSocket.all.at(-1);

beforeEach(() => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ token: 'single-use' }), text: async () => '' });
});

function client(extra = {}) {
  const seen = { partial: [], committed: [], fatal: [] };
  const stt = new ScribeRealtime({
    name: 'test',
    apiKey: 'key',
    languageCode: 'tr',
    keyterms: ['Fungo', 'cZAMA'],
    onPartial: (t) => seen.partial.push(t),
    onCommitted: (t) => seen.committed.push(t),
    onFatal: (e) => seen.fatal.push(e),
    ...extra,
  });
  return { stt, seen };
}

test('connects with a single-use token and the documented parameters', async () => {
  const { stt } = client();
  stt.start();
  await tick();
  const url = last().url;
  assert.equal(url.origin + url.pathname, 'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  assert.equal(url.searchParams.get('model_id'), 'scribe_v2_realtime');
  assert.equal(url.searchParams.get('token'), 'single-use');
  assert.equal(url.searchParams.get('audio_format'), 'pcm_16000');
  assert.equal(url.searchParams.get('commit_strategy'), 'vad');
  assert.equal(url.searchParams.get('language_code'), 'tr');
  assert.deepEqual(url.searchParams.getAll('keyterms'), ['Fungo', 'cZAMA']);
  stt.stop();
});

test('audio sent while connecting is kept and delivered once the session starts', async () => {
  const { stt } = client();
  stt.start();
  stt.sendAudio(new Int16Array([1, 2, 3]));
  await tick();
  stt.sendAudio(new Int16Array([4, 5]));
  assert.equal(last().sent.length, 0);
  last().emit({ message_type: 'session_started', session_id: 's', config: {} });
  assert.equal(last().sent.length, 2);
  const chunk = last().sent[0];
  assert.equal(chunk.message_type, 'input_audio_chunk');
  assert.equal(chunk.commit, false);
  assert.equal(chunk.sample_rate, 16000);
  assert.equal(typeof chunk.audio_base_64, 'string');
  stt.stop();
});

test('partial and committed transcripts reach the callbacks', async () => {
  const { stt, seen } = client();
  stt.start();
  await tick();
  last().emit({ message_type: 'session_started', session_id: 's', config: {} });
  last().emit({ message_type: 'partial_transcript', text: 'Merhaba' });
  last().emit({ message_type: 'committed_transcript', text: ' Merhaba nasılsın? ' });
  last().emit({ message_type: 'committed_transcript', text: '   ' });
  assert.deepEqual(seen.partial, ['Merhaba']);
  assert.deepEqual(seen.committed, ['Merhaba nasılsın?']);
  stt.stop();
});

test('an auth error stops for good instead of retrying', async () => {
  const { stt, seen } = client();
  stt.start();
  await tick();
  last().emit({ message_type: 'auth_error', error: 'bad key' });
  await tick(20);
  assert.equal(seen.fatal.length, 1);
  assert.equal(stt.status, 'failed');
  assert.equal(FakeSocket.all.length, 1);
});

test('a session that keeps failing to start is retried without the optional parameters', async () => {
  const { stt } = client();
  stt.start();
  await tick();
  last().close();
  await tick(450);
  last().close();
  await tick(900);
  const url = last().url;
  assert.ok(FakeSocket.all.length >= 3);
  assert.deepEqual(url.searchParams.getAll('keyterms'), []);
  assert.equal(url.searchParams.get('no_verbatim'), null);
  assert.equal(url.searchParams.get('language_code'), 'tr');
  stt.stop();
});

test('a long segment that already ends a sentence is committed by hand', async () => {
  const { stt } = client();
  stt.start();
  await tick();
  last().emit({ message_type: 'session_started', session_id: 's', config: {} });
  last().emit({ message_type: 'partial_transcript', text: `${'kelime '.repeat(90)}bitti.` });
  stt.sendAudio(new Int16Array(10));
  stt.sendAudio(new Int16Array(10));
  assert.equal(last().sent[0].commit, true);
  assert.equal(last().sent[1].commit, false);
  stt.stop();
});

// The server once showed a finished sentence, started the next segment and never
// committed the first one, so it was never translated (real Meet call, 29 Oct 2026).
async function started(extra) {
  const c = client({ vadSilenceSecs: 0.01, stallExtraSecs: 0.03, ...extra });
  c.stt.start();
  await tick();
  last().emit({ message_type: 'session_started', session_id: 's', config: {} });
  return c;
}

test('a finished segment the server never commits is committed from its last partial', async () => {
  const { stt, seen } = await started();
  last().emit({ message_type: 'partial_transcript', text: 'Hi. Thanks for' });
  last().emit({ message_type: 'partial_transcript', text: 'Hi. Thanks for joining the call today.' });
  await tick(80);
  assert.deepEqual(seen.committed, ['Hi. Thanks for joining the call today.']);
  stt.stop();
});

test('a new segment that replaces an uncommitted sentence closes that sentence first', async () => {
  const { stt, seen } = await started({ stallExtraSecs: 5 });
  last().emit({ message_type: 'partial_transcript', text: 'Hi. Thanks for joining the call today.' });
  last().emit({ message_type: 'partial_transcript', text: 'I wanted to talk' });
  assert.deepEqual(seen.committed, ['Hi. Thanks for joining the call today.']);
  last().emit({ message_type: 'committed_transcript', text: 'I wanted to talk about the launch timeline.' });
  assert.deepEqual(seen.committed, ['Hi. Thanks for joining the call today.', 'I wanted to talk about the launch timeline.']);
  stt.stop();
});

test('an empty commit keeps the words of the partial before it', async () => {
  const { stt, seen } = await started({ stallExtraSecs: 5 });
  last().emit({ message_type: 'partial_transcript', text: 'We need the final numbers' });
  last().emit({ message_type: 'committed_transcript', text: '' });
  assert.deepEqual(seen.committed, ['We need the final numbers']);
  stt.stop();
});

test('a late server commit of a segment closed here is not passed on twice', async () => {
  const { stt, seen } = await started();
  last().emit({ message_type: 'partial_transcript', text: 'Can we meet on Friday?' });
  await tick(80);
  last().emit({ message_type: 'committed_transcript', text: 'Can we meet on Friday?' });
  last().emit({ message_type: 'partial_transcript', text: 'Next week works too.' });
  last().emit({ message_type: 'committed_transcript', text: 'Next week works too.' });
  assert.deepEqual(seen.committed, ['Can we meet on Friday?', 'Next week works too.']);
  stt.stop();
});

test('a short partial is not committed on its own, and a growing one is not a new segment', async () => {
  const { stt, seen } = await started();
  last().emit({ message_type: 'partial_transcript', text: 'Okay.' });
  await tick(80);
  assert.deepEqual(seen.committed, []);
  const { stt: s2, seen: seen2 } = await started({ stallExtraSecs: 5 });
  for (const text of ['Hi.', 'Hi. Thanks for', 'Hi. Thanks for joining the call today.', 'Hi. Thanks for joining the call today. I wanted']) {
    last().emit({ message_type: 'partial_transcript', text });
  }
  assert.deepEqual(seen2.committed, []);
  stt.stop();
  s2.stop();
});

test('late server commits after two segments closed here are both dropped, and the live partial stays', async () => {
  const { stt, seen } = await started({ stallExtraSecs: 5 });
  last().emit({ message_type: 'partial_transcript', text: 'Hello. Thank you for the invitation.' });
  last().emit({ message_type: 'partial_transcript', text: 'Fifteen hundred on Friday works.' });
  last().emit({ message_type: 'partial_transcript', text: 'I will talk to' });
  last().emit({ message_type: 'committed_transcript', text: 'Hello. Thank you for the invitation.' });
  last().emit({ message_type: 'committed_transcript', text: '' });
  last().emit({ message_type: 'committed_transcript', text: 'I will talk to my team.' });
  assert.deepEqual(seen.committed, ['Hello. Thank you for the invitation.', 'Fifteen hundred on Friday works.', 'I will talk to my team.']);
  stt.stop();
});

test('the server repeating a committed segment as a partial does not commit it again', async () => {
  const { stt, seen } = await started();
  last().emit({ message_type: 'partial_transcript', text: 'Hello. Thank you for the invitation.' });
  last().emit({ message_type: 'committed_transcript', text: 'Hello. Thank you for the invitation.' });
  last().emit({ message_type: 'partial_transcript', text: 'Hello. Thank you for the invitation.' });
  last().emit({ message_type: 'partial_transcript', text: 'Could there be' });
  await tick(80);
  assert.deepEqual(seen.committed, ['Hello. Thank you for the invitation.', 'Could there be']);
  assert.deepEqual(seen.partial, ['Hello. Thank you for the invitation.', 'Could there be']);
  stt.stop();
});
