// While they are still talking, the words heard so far are translated on this computer
// by Chrome's own translator (free, a few milliseconds) and shown dimmed in the subtitles
// until the sentence's own translation replaces them. Only when that language pack is
// already on this computer: nothing is downloaded from here, and no key or credit is
// used, whichever translation the call itself uses.

import { words } from '../shared/text.js';
import { keepTerms, plainForMachine } from '../shared/plain.js';
import { matchCase } from './free-translator.js';

const MIN_WORDS = 2; // a word alone is often a guess in a silence ("Tamam.")
const RETRY_MS = 30000; // a pack that was not ready is looked for again after this

export class LiveDrafts {
  constructor({ api, onDraft, keyterms = [], now = () => Date.now() } = {}) {
    this.given = api;
    this.onDraft = onDraft;
    this.keyterms = keyterms;
    this.now = now;
    this.pair = null;
    this.opening = null;
    this.failedAt = -Infinity;
    this.generation = 0;
    this.wanted = '';
    this.translated = '';
    this.shown = false;
    this.busy = false;
  }

  // Chrome's translator, looked up when it is first needed.
  get api() {
    return this.given ?? globalThis.Translator;
  }

  setPair(from, to) {
    if (this.pair?.from === from && this.pair?.to === to) return;
    this.pair = { from, to };
    this.opening = null;
    this.failedAt = -Infinity;
    this.clear();
  }

  // The words heard so far that have no translation yet.
  heard(text) {
    const clean = String(text || '').trim();
    if (words(clean).length < MIN_WORDS) return;
    this.wanted = clean;
    this.run();
  }

  // The sentence was committed: its own translation takes the draft's place, so a draft
  // still being made for it is dropped.
  committed() {
    this.generation += 1;
    this.wanted = '';
    this.translated = '';
    this.shown = false;
  }

  // Nobody is being listened to any more (muted, turned off): the draft goes away.
  clear() {
    const shown = this.shown;
    this.committed();
    if (shown) this.onDraft?.('', '');
  }

  async run() {
    if (this.busy || !this.pair) return;
    this.busy = true;
    try {
      while (this.wanted && this.wanted !== this.translated) {
        const text = this.wanted;
        const generation = this.generation;
        const { from, to } = this.pair;
        const translator = await this.open();
        if (!translator) return;
        const out = matchCase(text, keepTerms(await translator.translate(plainForMachine(text, from)), this.keyterms), to).trim();
        if (generation !== this.generation) continue;
        this.translated = text;
        if (out) {
          this.shown = true;
          this.onDraft?.(out, text);
        }
      }
    } catch {
      // A draft is only a preview; the sentence's own translation still comes.
    } finally {
      this.busy = false;
    }
  }

  async open() {
    if (!this.opening) {
      if (this.now() - this.failedAt < RETRY_MS) return null;
      const options = { sourceLanguage: this.pair.from, targetLanguage: this.pair.to };
      this.opening = (async () => {
        if (typeof this.api?.availability !== 'function') return null;
        if ((await this.api.availability(options)) !== 'available') return null;
        return this.api.create(options);
      })().catch(() => null);
    }
    const translator = await this.opening;
    if (!translator) {
      this.opening = null;
      this.failedAt = this.now();
    }
    return translator;
  }
}
