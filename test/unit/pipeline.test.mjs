import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DirectionPipeline, History, Speaker } from '../../src/offscreen/pipeline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeTranslator(delays) {
  return {
    calls: [],
    async *translate({ text, signal }) {
      this.calls.push(text);
      const wait = delays[text] ?? 5;
      for (const piece of [`${text} one.`, `${text} two.`]) {
        await sleep(wait);
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield piece;
      }
    },
  };
}

function fakeSink() {
  return {
    pushed: [],
    ended: [],
    flushes: 0,
    push(id, chunk) {
      this.pushed.push({ id, chunk });
    },
    end(id) {
      this.ended.push(id);
    },
    flush() {
      this.flushes += 1;
    },
    backlog: () => 0,
  };
}

function setup({ delays = {}, synthDelay = 3, echo = () => false } = {}) {
  const sink = fakeSink();
  const synthCalls = [];
  const speaker = new Speaker({
    sink,
    synth: async function* (item) {
      synthCalls.push(item.text);
      for (let i = 0; i < 2; i++) {
        await sleep(synthDelay);
        if (item.signal.aborted) throw new DOMException('aborted', 'AbortError');
        yield `${item.text}#${i}`;
      }
    },
  });
  const events = [];
  const translator = fakeTranslator(delays);
  const pipeline = new DirectionPipeline({
    dir: 'in',
    from: 'en',
    to: 'tr',
    translator,
    speaker,
    history: new History(),
    echoGuard: { isEcho: echo },
    emit: (e) => events.push(e),
  });
  return { pipeline, sink, events, synthCalls, translator };
}

test('speech plays in the order it was said even when a later translation finishes first', async () => {
  const { pipeline, sink } = setup({ delays: { first: 40, second: 1 } });
  pipeline.onCommitted('first');
  pipeline.onCommitted('second');
  await sleep(250);
  const order = [...new Set(sink.pushed.map((p) => p.chunk.split('#')[0]))];
  assert.deepEqual(order, ['first one.', 'first two.', 'second one.', 'second two.']);
  assert.equal(sink.ended.length, 4);
});

test('subtitle mode translates but never asks for speech', async () => {
  const { pipeline, sink, events, synthCalls } = setup();
  pipeline.setMode('text');
  pipeline.onCommitted('hello');
  await sleep(80);
  assert.equal(synthCalls.length, 0);
  assert.equal(sink.pushed.length, 0);
  assert.ok(events.some((e) => e.phase === 'translated' && e.translation === 'hello one. hello two.'));
});

test('off mode ignores what is heard', async () => {
  const { pipeline, translator } = setup();
  pipeline.setMode('off');
  pipeline.onCommitted('hello');
  await sleep(40);
  assert.equal(translator.calls.length, 0);
});

test('flush stops translation and speech that has not been heard yet', async () => {
  const { pipeline, sink } = setup({ delays: { long: 30 }, synthDelay: 20 });
  pipeline.onCommitted('long');
  await sleep(45);
  pipeline.flush();
  const before = sink.pushed.length;
  await sleep(200);
  assert.equal(sink.pushed.length, before);
  assert.ok(sink.flushes >= 1);
});

test('switching to subtitles mid-sentence stops the voice but keeps the translation', async () => {
  const { pipeline, sink, events } = setup({ delays: { talk: 20 }, synthDelay: 25 });
  pipeline.onCommitted('talk');
  await sleep(30);
  pipeline.setMode('text');
  const before = sink.pushed.length;
  await sleep(150);
  assert.equal(sink.pushed.length, before);
  assert.ok(events.some((e) => e.phase === 'translated'));
});

test('an echo of our own voice is dropped', async () => {
  const { pipeline, events, translator } = setup({ echo: () => true });
  pipeline.onCommitted('can we meet on friday');
  await sleep(20);
  assert.equal(translator.calls.length, 0);
  assert.equal(events[0].phase, 'echo');
});

test('history gives each translation the conversation so far', async () => {
  const history = new History(3);
  history.add({ id: 'a', dir: 'in', source: 'one', translation: '' });
  history.setTranslation('a', 'bir');
  history.add({ id: 'b', dir: 'out', source: 'iki', translation: '' });
  history.add({ id: 'c', dir: 'in', source: 'three', translation: '' });
  history.add({ id: 'd', dir: 'out', source: 'dört', translation: '' });
  assert.deepEqual(history.recent(8).map((x) => x.id), ['b', 'c', 'd']);
});
