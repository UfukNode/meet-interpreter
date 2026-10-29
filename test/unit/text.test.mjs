import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentenceSplitter, EchoGuard, lcsLength, words, isOnlyPunctuation } from '../../src/shared/text.js';

test('streamed text is cut at sentence ends', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('Hello there, my friend. How are'), ['Hello there, my friend.']);
  assert.deepEqual(s.push(' you doing today? Fine'), ['How are you doing today?']);
  assert.equal(s.flush(), 'Fine');
});

test('very short sentences are kept together with the next one', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('Ok. Then we go there. Next'), ['Ok. Then we go there.']);
});

test('decimals and a sentence end without a following space are not cut', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('It costs 3.5 million dollars.'), []);
  assert.equal(s.flush(), 'It costs 3.5 million dollars.');
});

test('a long sentence is cut at a comma', () => {
  const s = new SentenceSplitter({ softMax: 60 });
  const pieces = s.push('We looked at the numbers for the last quarter, and the growth was strong in every region we');
  assert.equal(pieces.length, 1);
  assert.ok(pieces[0].endsWith(','));
});

test('Turkish text is split the same way', () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push('Cuma günü saat üçte buluşalım mı? Bence uygun'), ['Cuma günü saat üçte buluşalım mı?']);
});

test('word helpers', () => {
  assert.deepEqual(words('Çok güzel, değil mi?'), ['cok', 'guzel', 'degil', 'mi']);
  assert.equal(lcsLength(['a', 'b', 'c', 'd'], ['b', 'x', 'c', 'd']), 3);
  assert.ok(isOnlyPunctuation(' ... '));
  assert.ok(!isOnlyPunctuation('Tamam.'));
});

test('our own voice coming back right away is an echo', () => {
  const guard = new EchoGuard();
  guard.remember('Can we meet on Friday at three?', { start: 1000, end: 3000 });
  assert.equal(guard.isEcho('can we meet on Friday at three', 4000), true);
});

test('a later reply that reuses the same words is not an echo', () => {
  const guard = new EchoGuard();
  guard.remember('Can we meet on Friday at three?', { start: 1000, end: 3000 });
  assert.equal(guard.isEcho('Yes, we can meet on Friday at three.', 9000), false);
});

test('a quick but different reply is not an echo', () => {
  const guard = new EchoGuard();
  guard.remember('Can we meet on Friday at three?', { start: 1000, end: 3000 });
  assert.equal(guard.isEcho('Yes Friday at three works for me', 3500), false);
});

test('short utterances are never treated as echoes', () => {
  const guard = new EchoGuard();
  guard.remember('Thank you', { start: 1000, end: 2000 });
  assert.equal(guard.isEcho('Thank you', 2500), false);
});

import { EarlySentences, finishedSentenceEnd, remainderAfter } from '../../src/shared/text.js';

// Partial transcripts as Scribe v2 Realtime sent them for test/e2e/fixtures/english.wav.
const PARTIALS = [
  'Hi.',
  'Hi. Thank-',
  'Hi. Thanks for joining the call today.',
  'Hi. Thanks for joining the call today. I wanted to talk',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at 3:00 in the afternoon.',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at 3:00 in the afternoon. Does that',
  'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at 3:00 in the afternoon. Does that work for your team?',
];
const FINAL = 'Hi. Thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at 3:00 in the afternoon. Does that work for your team?';

test('finished sentences are sent while the speaker keeps talking, each once', () => {
  const early = new EarlySentences();
  const sent = PARTIALS.map((p) => early.partial(p)).filter(Boolean);
  assert.deepEqual(sent, [
    'Hi. Thanks for joining the call today.',
    'I wanted to talk about the launch timeline.',
    'We are planning to open the public sale next Friday at 3:00 in the afternoon.',
  ]);
  assert.equal(early.committed(FINAL), 'Does that work for your team?');
});

test('a sentence is only sent once more words follow it and it has stayed the same', () => {
  const early = new EarlySentences();
  assert.equal(early.partial('We should meet on Friday.'), '');
  assert.equal(early.partial('We should meet on Friday. And'), '');
  assert.equal(early.partial('We should meet on Friday. And then'), 'We should meet on Friday.');
});

test('a segment with nothing sent ahead is committed whole', () => {
  const early = new EarlySentences();
  early.partial('Yes.');
  assert.equal(early.committed('Yes, that works.'), 'Yes, that works.');
});

test('the live line shows only what has not been sent', () => {
  const early = new EarlySentences();
  early.partial('First point is clear. Second');
  early.partial('First point is clear. Second one');
  assert.equal(early.live('First point is clear. Second one is'), 'Second one is');
});

test('abbreviations, initials and decimals do not end a sentence', () => {
  assert.equal(finishedSentenceEnd('Hello Mr. Smith, how are you'), 0);
  assert.equal(finishedSentenceEnd('Ask J. Doe about it'), 0);
  assert.equal(finishedSentenceEnd('It costs 3.5 million. Then'), 'It costs 3.5 million.'.length);
});

test('small changes in the final transcript are tolerated', () => {
  assert.equal(remainderAfter('Hi. Thanks for joining the call today.', 'Hi, thanks for joining the call today! I wanted to talk.'), 'I wanted to talk.');
  assert.equal(remainderAfter('Merhaba. Davet için teşekkürler.', 'Merhaba, davet için teşekkürler. Cuma günü uygun.'), 'Cuma günü uygun.');
  assert.equal(remainderAfter('Completely different words here.', 'Nothing alike at all.'), 'Nothing alike at all.');
});

test('a final transcript that only revises what was sent ahead adds nothing', () => {
  const early = new EarlySentences();
  early.partial('Cuma günü saat üç bizim için uygundur. Ekibimle');
  assert.equal(early.partial('Cuma günü saat üç bizim için uygundur. Ekibimle'), 'Cuma günü saat üç bizim için uygundur.');
  assert.equal(early.committed('Cuma günü saat üç bizim için uygun. Ekibimle konuşacağım.'), 'Ekibimle konuşacağım.');
  const same = new EarlySentences();
  same.partial('Bu çok kolay. Tekrar');
  same.partial('Bu çok kolay. Tekrar');
  assert.equal(same.committed('Bu çok kolay'), '');
});
