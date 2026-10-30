// One direction of the call: committed transcript in, translated speech out.
//
//   committed text -> Claude (streams sentences) -> ElevenLabs (streams audio) -> sink
//
// Translations of consecutive segments run in parallel, but speech always plays in
// the order it was said. Each sentence starts its speech request as soon as it is
// known, so the next sentence is usually ready before the current one has finished.

import { Watchdog } from '../shared/watchdog.js';

export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
  }

  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error) {
    this.error = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

// Both directions share one history so each translation sees the whole conversation.
export class History {
  constructor(max = 12) {
    this.max = max;
    this.items = [];
  }

  add(entry) {
    this.items.push(entry);
    if (this.items.length > this.max) this.items.shift();
  }

  setTranslation(id, translation) {
    const item = this.items.find((x) => x.id === id);
    if (item) item.translation = translation;
  }

  recent(n) {
    return this.items.slice(-n).map((x) => ({ ...x }));
  }
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.constructor?.name === 'APIUserAbortError';
}

// A translation that sends nothing more for this long is given up (a TimeoutError), so
// the speech queued after it can go on.
const TRANSLATION_STALL_MS = 15000;

// Plays speech items strictly in order, fetching ahead while earlier items play.
export class Speaker {
  constructor({ synth, sink, onFirstAudio, onSpoken, onError }) {
    this.synth = synth;
    this.sink = sink;
    this.onFirstAudio = onFirstAudio;
    this.onSpoken = onSpoken;
    this.onError = onError;
    this.items = [];
    this.running = false;
    this.counter = 0;
  }

  // item: { segment, text, previousText }. Speech has its own abort signal, so it can be
  // stopped (subtitle mode) without stopping the translation it belongs to.
  enqueue(item) {
    item.id = `${item.segment.id}.${++this.counter}`;
    const speech = new AbortController();
    const segmentSignal = item.segment.controller.signal;
    if (segmentSignal.aborted) speech.abort();
    else segmentSignal.addEventListener('abort', () => speech.abort(), { once: true });
    item.signal = speech.signal;
    item.cancel = () => speech.abort();
    item.audio = new AsyncQueue();
    (async () => {
      try {
        for await (const chunk of this.synth(item)) item.audio.push(chunk);
        item.audio.close();
      } catch (err) {
        item.audio.fail(err);
      }
    })();
    this.items.push(item);
    if (!this.running) this.run();
  }

  async run() {
    this.running = true;
    while (this.items.length) {
      const item = this.items.shift();
      this.current = item;
      if (item.signal.aborted) continue;
      let startedAt = 0;
      try {
        for await (const chunk of item.audio) {
          if (item.signal.aborted) break;
          if (!startedAt) {
            startedAt = Date.now() + this.sink.backlog() * 1000;
            this.onFirstAudio?.(item);
          }
          this.sink.push(item.id, chunk);
        }
        if (!item.signal.aborted) {
          this.sink.end(item.id);
          if (startedAt) this.onSpoken?.(item, { start: startedAt, end: Date.now() + this.sink.backlog() * 1000 });
        }
      } catch (err) {
        if (!isAbortError(err) && !item.signal.aborted) this.onError?.(item, err);
      }
    }
    this.current = null;
    this.running = false;
  }

  // Seconds of speech waiting to be fetched or played, estimated from text length.
  pendingSeconds() {
    return this.items.reduce((s, item) => s + item.text.length * 0.065, 0);
  }

  // Cancels every queued and playing item and drops what the sink still holds.
  cancelAll() {
    for (const item of this.items) item.cancel();
    this.current?.cancel();
    this.items = [];
    this.sink.flush();
  }
}

export class DirectionPipeline {
  constructor({ dir, from, to, translator, speaker, history, echoGuard, emit, describeError, isConcise, stallMs = TRANSLATION_STALL_MS }) {
    this.dir = dir;
    this.stallMs = stallMs;
    this.from = from;
    this.to = to;
    this.translator = translator;
    this.speaker = speaker;
    this.history = history;
    this.echoGuard = echoGuard;
    this.emit = emit;
    this.describeError = describeError || ((err) => err?.message || String(err));
    this.isConcise = isConcise || (() => false);
    this.mode = 'voice';
    this.counter = 0;
    this.generation = 0;
    this.chain = Promise.resolve();
    this.live = new Set();
  }

  // 'voice': translate and speak; 'text': translate for the subtitles only; 'off': ignore.
  setMode(mode) {
    if (mode === this.mode) return;
    const previous = this.mode;
    this.mode = mode;
    if (mode === 'off') this.flush();
    else if (previous === 'voice') this.silence();
  }

  onCommitted(text) {
    if (this.mode === 'off') return;
    if (this.echoGuard?.isEcho(text)) {
      this.emit({ phase: 'echo', source: text });
      return;
    }
    const segment = {
      id: `${this.dir}${++this.counter}`,
      source: text,
      translation: '',
      committedAt: performance.now(),
      controller: new AbortController(),
      sentences: new AsyncQueue(),
    };
    this.live.add(segment);
    const context = this.history.recent(8);
    this.history.add({ id: segment.id, dir: this.dir, source: text, translation: '' });
    this.emit({ id: segment.id, phase: 'committed', source: text });
    this.translate(segment, context);
    const generation = this.generation;
    this.chain = this.chain
      .then(() => (generation === this.generation ? this.queueSpeech(segment) : undefined))
      .catch(() => {})
      .finally(() => this.live.delete(segment));
  }

  async translate(segment, context) {
    const signal = segment.controller.signal;
    const watch = new Watchdog(signal, this.stallMs);
    try {
      const pieces = this.translator.translate({
        text: segment.source,
        from: this.from,
        to: this.to,
        history: context,
        concise: this.isConcise(),
        signal: watch.signal,
      });
      for await (const piece of watch.guard(pieces)) {
        if (signal.aborted) break;
        if (!segment.firstTextAt) segment.firstTextAt = performance.now();
        segment.translation = segment.translation ? `${segment.translation} ${piece}` : piece;
        segment.sentences.push(piece);
        this.emit({ id: segment.id, phase: 'translating', source: segment.source, translation: segment.translation });
      }
      this.history.setTranslation(segment.id, segment.translation);
      if (!signal.aborted) {
        this.emit({
          id: segment.id,
          phase: 'translated',
          source: segment.source,
          translation: segment.translation,
          translateMs: Math.round(performance.now() - segment.committedAt),
        });
      }
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) {
        this.emit({ id: segment.id, phase: 'error', source: segment.source, error: this.describeError(err) });
      }
    } finally {
      watch.done();
      segment.sentences.close();
    }
  }

  async queueSpeech(segment) {
    let previousText = '';
    for await (const text of segment.sentences) {
      if (segment.controller.signal.aborted) return;
      // In subtitle mode the sentences are only drained; no speech is requested or billed.
      if (this.mode !== 'voice') continue;
      this.speaker.enqueue({ segment, text, previousText });
      previousText = text;
    }
  }

  // Stops speech that is queued or playing but keeps translating (switch to subtitles).
  silence() {
    this.speaker.cancelAll();
  }

  // Drops everything not yet heard: used on mute, on stop and when a direction is turned off.
  flush() {
    this.generation += 1;
    for (const segment of this.live) segment.controller.abort();
    this.live.clear();
    this.speaker.cancelAll();
  }
}
