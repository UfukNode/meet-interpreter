import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnEnd, readsFinished } from '../../src/shared/turn.js';

const SPEECH = 0.05;
const QUIET = 0.001;

// A turn tracker for a Turkish speaker on a fake clock, fed 100 ms chunks the way the
// capture worklet sends them.
function tracker(options = {}) {
  let clock = 10_000;
  const turn = new TurnEnd({ holdSecs: 0.7, language: 'tr', now: () => clock, ...options });
  return {
    turn,
    // Feeds `n` chunks at `rms` and returns the clock time (ms) and result of each.
    feed(rms, n) {
      const out = [];
      for (let i = 0; i < n; i++) {
        clock += 100;
        out.push({ at: clock, result: turn.level(rms) });
      }
      return out;
    },
    partial(text) {
      return turn.partial(text);
    },
    get clock() {
      return clock;
    },
  };
}

const commitsAt = (chunks) => chunks.filter((c) => c.result === 'commit').map((c) => c.at);

test('a finished sentence reads as finished, one that needs more does not', () => {
  assert.equal(readsFinished('Merhaba, davet için teşekkür ederim.', 'tr'), true);
  assert.equal(readsFinished('Fiyat konusunda biraz esneklik olabilir mi?', 'tr'), true);
  assert.equal(readsFinished('Raporu hazırladım ama.', 'tr'), false);
  assert.equal(readsFinished('Bence fiyat biraz yüksek', 'tr'), false);
  assert.equal(readsFinished('Sizinle görüşmek-', 'tr'), false);
  assert.equal(readsFinished('I can send it to the.', 'en'), false);
  assert.equal(readsFinished('Great, see you on Friday!', 'en'), true);
  // Languages without a word list go by the punctuation alone.
  assert.equal(readsFinished('Das ist gut und.', 'de'), true);
  assert.equal(readsFinished('', 'en'), false);
});

test('after speech, a silence as long as the setting closes the segment once', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  t.partial('Cuma günü saat üç bizim için uy');
  const silent = t.feed(QUIET, 12);
  assert.equal(commitsAt(silent).length, 1);
  assert.equal(silent.findIndex((c) => c.result === 'commit'), 6); // the 7th quiet chunk: 0.7 s
});

test('a finished sentence heard during the silence closes it sooner', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  const first = t.feed(QUIET, 3); // 0.3 s of silence
  assert.deepEqual(commitsAt(first), []);
  // The partial that shows the whole sentence comes a moment after the speech stopped.
  assert.equal(t.partial('Merhaba, davet için teşekkür ederim.'), '');
  const next = t.feed(QUIET, 1); // 0.4 s: past the 0.35 s quick silence
  assert.equal(next[0].result, 'commit');
});

test('a partial at once past the quick silence commits right away', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  t.feed(QUIET, 5);
  assert.equal(t.partial('Fiyat konusunda biraz esneklik olabilir mi?'), 'commit');
  assert.deepEqual(commitsAt(t.feed(QUIET, 5)), []); // only once
});

test('a sentence that needs more words waits for the full silence', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  t.feed(QUIET, 3);
  t.partial('Raporu hazırladım ama.');
  const rest = t.feed(QUIET, 6);
  assert.equal(rest.findIndex((c) => c.result === 'commit'), 3); // 0.3 + 0.4 = 0.7 s
});

test('a finished-looking partial from before the silence does not count', () => {
  const t = tracker();
  t.feed(SPEECH, 8);
  t.partial('Merhaba.'); // stale: the speaker went on talking after this
  t.feed(SPEECH, 4);
  const silent = t.feed(QUIET, 8);
  assert.equal(silent.findIndex((c) => c.result === 'commit'), 6);
});

test('a pause shorter than the setting keeps the segment open', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  t.partial('Raporu hazırladım');
  assert.deepEqual(commitsAt(t.feed(QUIET, 5)), []);
  assert.equal(t.feed(SPEECH, 1)[0].result, 'speech');
  assert.deepEqual(commitsAt(t.feed(SPEECH, 5)), []);
  assert.equal(commitsAt(t.feed(QUIET, 7)).length, 1);
});

test('no commit without speech or without words to commit', () => {
  const quiet = tracker();
  quiet.partial('Tamam.'); // recognition guessing a word in silence
  assert.deepEqual(commitsAt(quiet.feed(QUIET, 20)), []);
  const wordless = tracker();
  wordless.feed(SPEECH, 10);
  assert.deepEqual(commitsAt(wordless.feed(QUIET, 20)), []);
});

test('long speech never lifts the noise floor, so its end is still found', () => {
  const t = tracker();
  t.feed(QUIET, 20);
  // Half a minute of quiet speech, with the short gaps between words that speech has.
  const talk = [];
  for (let i = 0; i < 60; i++) talk.push(...t.feed(0.03, 4), ...t.feed(0.004, 1));
  assert.deepEqual(commitsAt(talk), []);
  t.partial('Uzun bir konuşmanın son cümlesi');
  assert.equal(commitsAt(t.feed(QUIET, 8)).length, 1);
});

test('steady room noise counts as silence, and a louder voice still counts as speech', () => {
  const t = tracker();
  t.feed(0.004, 30); // a fan
  t.feed(0.04, 10);
  t.partial('Bugün geliyorum');
  const silent = t.feed(0.004, 8);
  assert.equal(silent.findIndex((c) => c.result === 'commit'), 6);
});

test('louder steady noise is learned within seconds, after which it counts as silence', () => {
  const t = tracker();
  t.feed(0.02, 100); // a busy room, loud enough to pass for speech at first
  const talk = t.feed(0.09, 15);
  assert.equal(talk[0].result, 'speech');
  t.partial('Toplantı saat üçte başlıyor');
  const after = t.feed(0.02, 10);
  assert.equal(after.findIndex((c) => c.result === 'commit'), 6);
});

test('the segment remembers when its speech ended, and the next one starts fresh', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  const speechEnd = t.clock; // the last loud chunk ends here
  t.partial('Bugün geliyorum');
  t.feed(QUIET, 7);
  assert.equal(t.turn.committed(), speechEnd);
  // Still quiet after the commit: nothing more to close.
  t.partial('');
  assert.deepEqual(commitsAt(t.feed(QUIET, 10)), []);
});

test('commits are at least a second apart', () => {
  const t = tracker({ holdSecs: 0.3 });
  t.feed(SPEECH, 3);
  t.partial('Evet.');
  assert.equal(commitsAt(t.feed(QUIET, 3)).length, 1);
  t.turn.committed();
  t.feed(SPEECH, 3);
  t.partial('Tamam.');
  const quick = t.feed(QUIET, 3);
  assert.deepEqual(commitsAt(quick), []); // 0.6 s after the last one
  assert.equal(commitsAt(t.feed(QUIET, 5)).length, 1);
});

test('a commit that comes while the speaker is still talking has no end of speech', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  t.feed(QUIET, 4); // a pause inside the segment
  t.feed(SPEECH, 6);
  assert.equal(t.turn.committed(), null);
});

test('a segment closed here keeps its end of speech when the next sentence starts at once', () => {
  const t = tracker();
  t.feed(SPEECH, 10);
  const speechEnd = t.clock;
  t.partial('Bugün geliyorum');
  assert.equal(commitsAt(t.feed(QUIET, 7)).length, 1);
  t.feed(SPEECH, 2); // talking again before the commit came back
  assert.equal(t.turn.committed(), speechEnd);
});

test('speech since the last commit is what a quiet partial needs to be committed', () => {
  const t = tracker();
  assert.equal(t.turn.heardSpeech(), false);
  t.feed(SPEECH, 3);
  assert.equal(t.turn.heardSpeech(), true);
  t.turn.committed();
  assert.equal(t.turn.heardSpeech(), false);
});
