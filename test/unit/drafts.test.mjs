import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveDrafts } from '../../src/offscreen/drafts.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// A stand-in for Chrome's Translator API that answers after `delay` ms.
function fakeApi({ state = 'available', delay = 1 } = {}) {
  const api = {
    calls: [],
    created: 0,
    availability: async () => state,
    create: async () => {
      api.created += 1;
      return {
        translate: async (text) => {
          api.calls.push(text);
          await tick(delay);
          return `tr:${text}`;
        },
      };
    },
  };
  return api;
}

function drafts(api, extra = {}) {
  const shown = [];
  const d = new LiveDrafts({ api, onDraft: (translation) => shown.push(translation), ...extra });
  d.setPair('en', 'tr');
  return { d, shown };
}

test('the words heard so far are translated on this computer and shown as a draft', async () => {
  const api = fakeApi();
  const { d, shown } = drafts(api);
  d.heard('Hi, thanks for joining');
  await tick(20);
  assert.deepEqual(shown, ['Tr:Hi, thanks for joining']);
  d.heard('Hi, thanks for joining');
  await tick(20);
  assert.equal(api.calls.length, 1); // the same words are not translated twice
  assert.equal(api.created, 1);
});

test('everyday phrases go in plainer words, and a single word is no draft', async () => {
  const api = fakeApi();
  const { d } = drafts(api);
  d.heard('Okay.');
  d.heard("Let's touch base on Monday");
  await tick(20);
  assert.deepEqual(api.calls, ["Let's talk briefly on Monday"]);
});

test('a draft still being made when the sentence is committed is dropped', async () => {
  const api = fakeApi({ delay: 30 });
  const { d, shown } = drafts(api);
  d.heard('We are planning to open');
  await tick(5);
  d.committed();
  await tick(60);
  assert.deepEqual(shown, []);
});

test('the newest words win while a translation is under way', async () => {
  const api = fakeApi({ delay: 20 });
  const { d, shown } = drafts(api);
  d.heard('We are planning');
  d.heard('We are planning to open');
  d.heard('We are planning to open the sale');
  await tick(80);
  assert.deepEqual(api.calls, ['We are planning', 'We are planning to open the sale']);
  assert.equal(shown.at(-1), 'Tr:We are planning to open the sale');
});

test('clearing takes a shown draft away, and nothing happens without the language pack', async () => {
  const api = fakeApi();
  const { d, shown } = drafts(api);
  d.heard('Thanks for joining');
  await tick(20);
  d.clear();
  assert.deepEqual(shown, ['Tr:Thanks for joining', '']);

  let clock = 0;
  const missing = fakeApi({ state: 'downloadable' });
  const { d: d2, shown: shown2 } = drafts(missing, { now: () => clock });
  d2.heard('Thanks for joining');
  await tick(20);
  d2.heard('Thanks for joining the call');
  await tick(20);
  assert.deepEqual(shown2, []);
  assert.equal(missing.created, 0);
});
