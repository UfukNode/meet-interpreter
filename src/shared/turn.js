// Decides from the audio level when a speaker has finished, so speech recognition can be
// told to close the segment at once. Its own silence detection commits about 0.4 s after
// its threshold (measured: 1.1 to 1.3 s after the speech with a 0.7 s threshold), while
// a commit sent from here comes back in about 0.25 s.
//
// A segment is closed when
// - the silence has lasted `holdSecs` (the "Silence that ends a phrase" setting), or
// - it has lasted `quickSecs` and a partial transcript that came at least `freshSecs`
//   after the speech stopped reads as a finished sentence: it ends with a full stop, a
//   question or an exclamation mark, and not with a word that needs more after it
//   ("ama.", "and."). Partials run about half a second behind the audio, so an earlier
//   one may not show the last words yet.
// For noise that never lets the level fall, speech recognition commits a partial that has
// stopped changing (offscreen/stt.js). Closing a segment early only costs a split sentence
// if the speaker goes on after the pause; no words are lost, since a commit takes all the
// audio heard so far.

import { words } from './text.js';

// Words a sentence does not end on; recognition still puts a full stop after them when
// the speaker pauses ("Raporu hazırladım ama.").
const CONNECTORS = {
  tr: ['ve', 'veya', 'ya', 'yahut', 'ama', 'fakat', 'ancak', 'lakin', 'çünkü', 'ki', 'yani', 'eğer', 'şayet', 'hem', 'ne', 'de', 'da', 'ile', 'için', 'gibi', 'kadar', 'diye', 'mesela', 'örneğin', 'şey', 'hani', 'ise', 'olarak', 'bu', 'şu', 'bir', 'her', 'en', 'çok', 'daha', 'sonra', 'önce'],
  en: ['and', 'or', 'but', 'because', 'so', 'that', 'which', 'who', 'if', 'when', 'while', 'although', 'though', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'as', 'than', 'like', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'this', 'these', 'those', 'is', 'are', 'was', 'were', 'will', 'would', 'can', 'could', 'should', 'um', 'uh'],
};
const connectorSets = Object.fromEntries(Object.entries(CONNECTORS).map(([lang, list]) => [lang, new Set(list.map((w) => words(w).join('')))]));

const FINISHED = /[.!?…。！？]["'”’»)\]]*\s*$/u;
const RECENT_CHUNKS = 50; // 5 s of 100 ms chunks

export function readsFinished(text, language) {
  const heard = words(text);
  if (!heard.length || !FINISHED.test(text) || /-\s*$/.test(text)) return false;
  const connectors = connectorSets[String(language || '').slice(0, 2)];
  return !connectors?.has(heard[heard.length - 1]);
}

export class TurnEnd {
  constructor({ holdSecs = 0.7, quickSecs = 0.35, freshSecs = 0.3, minSpeechSecs = 0.2, minGapMs = 1000, minLevel = 0.006, language = '', now = () => performance.now() } = {}) {
    this.holdSecs = holdSecs;
    this.quickSecs = Math.min(quickSecs, holdSecs);
    this.freshSecs = freshSecs;
    this.minSpeechSecs = minSpeechSecs;
    this.minGapMs = minGapMs;
    this.minLevel = minLevel;
    this.language = language;
    this.now = now;
    this.floor = 0.003;
    this.recent = []; // the levels of the last RECENT_CHUNKS chunks
    this.speaking = false;
    this.lastCommitAt = -Infinity;
    this.reset();
  }

  reset() {
    this.speechSecs = 0;
    this.silenceSecs = 0;
    this.silentSince = null;
    this.endedAt = null;
    this.partialText = '';
    this.partialAt = -Infinity;
    this.fired = false;
    this.closedEndAt = null; // when the speech of a segment closed here ended
  }

  // One chunk of audio: its RMS level (0..1) and length. Returns 'commit' when the
  // segment should be closed now, 'speech' when speech starts after a pause, else ''.
  level(rms, chunkSecs = 0.1) {
    const now = this.now();
    // The noise floor follows quiet stretches down at once and rises slowly, never above
    // the quietest chunk of the last few seconds. The gaps between words keep it down while
    // someone talks; steady noise (a fan, a busy room) lifts it within about 8 s, after
    // which that noise counts as silence.
    this.recent.push(rms);
    if (this.recent.length > RECENT_CHUNKS) this.recent.shift();
    if (rms < this.floor) this.floor = this.floor * 0.7 + rms * 0.3;
    else this.floor = Math.min(this.floor * 1.02, Math.min(...this.recent));
    const threshold = Math.max(this.minLevel, this.floor * 3);
    if (rms > threshold) {
      const started = !this.speaking;
      this.speaking = true;
      this.speechSecs += chunkSecs;
      this.silenceSecs = 0;
      this.silentSince = null;
      this.endedAt = null; // a pause inside the segment is not its end
      this.fired = false;
      return started ? 'speech' : '';
    }
    this.speaking = false;
    if (this.silentSince === null) {
      this.silentSince = now;
      this.endedAt = now - chunkSecs * 1000;
    }
    this.silenceSecs += chunkSecs;
    return this.decide(now) ? 'commit' : '';
  }

  // A partial transcript arrived. Returns 'commit' when the segment should be closed now.
  partial(text) {
    this.partialText = text;
    this.partialAt = this.now();
    return this.decide(this.partialAt) ? 'commit' : '';
  }

  decide(now) {
    if (this.fired || this.silentSince === null || this.speechSecs < this.minSpeechSecs || !this.partialText.trim()) return false;
    if (now - this.lastCommitAt < this.minGapMs) return false;
    const heldLongEnough = this.silenceSecs >= this.holdSecs - 1e-9;
    const fresh = this.endedAt !== null && this.partialAt >= this.endedAt + this.freshSecs * 1000;
    const quick = this.silenceSecs >= this.quickSecs - 1e-9 && fresh && readsFinished(this.partialText, this.language);
    if (!heldLongEnough && !quick) return false;
    this.fired = true;
    this.closedEndAt = this.endedAt;
    this.lastCommitAt = now;
    // For the tests and the debug copy: which rule closed it, and how fresh the partial was.
    this.lastClose = { quick: quick && !heldLongEnough, silenceSecs: this.silenceSecs, partialAfterMs: Math.round(this.partialAt - this.endedAt) };
    return true;
  }

  // Whether anyone has spoken since the last commit (noise loud enough counts too).
  heardSpeech() {
    return this.speechSecs >= this.minSpeechSecs;
  }

  // The segment was committed (by us or by recognition): start counting the next one.
  // Returns when its speech ended, if known; the speaker may already be talking again.
  committed() {
    const endedAt = this.endedAt ?? this.closedEndAt;
    const silentSince = this.silentSince;
    const silenceSecs = this.silenceSecs;
    const fired = this.fired;
    this.reset();
    // Still silent: the silence goes on, but it no longer belongs to a segment with speech.
    if (silentSince !== null) {
      this.silentSince = silentSince;
      this.silenceSecs = silenceSecs;
      this.fired = fired;
    }
    return endedAt;
  }
}
