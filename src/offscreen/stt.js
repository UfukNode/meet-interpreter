import { fetchScribeToken, ElevenLabsError } from '../shared/elevenlabs.js';
import { int16ToBase64 } from '../shared/pcm.js';
import { words, lcsLength } from '../shared/text.js';

const REALTIME_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

// Server messages that end the session for good, need a fresh connection, or are only worth a log line.
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms']);
const RECONNECT = new Set([
  'error',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'transcriber_error',
  'invalid_request',
]);

// In a real call the server once showed a finished sentence as a partial, began the next
// segment and never committed the first one, so it was never translated. A segment that
// stays uncommitted this long after the silence that should have closed it, or that a
// clearly new segment replaces, is committed here with its last partial.
const STALL_EXTRA_SECS = 2.5;
const MIN_RECOVERED_WORDS = 3;

export class SttFatalError extends Error {
  constructor(type, message) {
    super(message || type);
    this.type = type;
  }
}

// One Scribe v2 Realtime session for one direction of the call. It reconnects on its
// own (with a new single-use token each time) and keeps up to five seconds of audio
// while it is reconnecting, so nothing said in the gap is lost.
export class ScribeRealtime {
  constructor({ name, apiKey, languageCode, vadSilenceSecs = 0.7, stallExtraSecs = STALL_EXTRA_SECS, keyterms = [], onPartial, onCommitted, onServerMessage, onStatus, onFatal, log }) {
    this.name = name;
    this.apiKey = apiKey;
    this.languageCode = languageCode;
    this.vadSilenceSecs = vadSilenceSecs;
    this.stallExtraSecs = stallExtraSecs;
    this.keyterms = keyterms;
    this.onPartial = onPartial;
    this.onCommitted = onCommitted;
    this.onServerMessage = onServerMessage;
    this.onStatus = onStatus;
    this.onFatal = onFatal;
    this.log = log || (() => {});
    this.ws = null;
    this.ready = false;
    this.stopped = true;
    this.attempts = 0;
    this.backlog = [];
    this.partial = '';
    this.stallTimer = null;
    this.localCommits = [];
    this.lastCommit = null;
    this.pendingCommit = false;
    this.manualCommits = true;
    this.lastForcedCommit = 0;
    this.failedBeforeStart = 0;
    this.minimal = false;
    this.status = 'idle';
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  setStatus(status, detail) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  async connect() {
    if (this.stopped) return;
    this.setStatus(this.attempts ? 'reconnecting' : 'connecting');
    let token;
    try {
      token = await fetchScribeToken(this.apiKey);
    } catch (err) {
      if (err instanceof ElevenLabsError && !err.retryable) return this.fail(new SttFatalError('token', err.message), err);
      return this.retryLater(err);
    }
    if (this.stopped) return;

    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      token,
      audio_format: 'pcm_16000',
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(this.vadSilenceSecs),
    });
    if (this.languageCode) params.set('language_code', this.languageCode);
    // The optional extras are dropped if the server keeps refusing the session with them.
    if (!this.minimal) {
      params.set('no_verbatim', 'true');
      for (const term of this.keyterms) params.append('keyterms', term);
    }

    const ws = new WebSocket(`${REALTIME_URL}?${params}`);
    this.ws = ws;
    this.ready = false;
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onMessage(event.data);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (!this.stopped) this.retryLater(new Error(`connection closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`));
    };
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.message_type) {
      case 'session_started':
        this.ready = true;
        this.attempts = 0;
        this.failedBeforeStart = 0;
        this.setStatus('ready');
        this.drain();
        return;
      case 'partial_transcript': {
        const text = msg.text || '';
        // The server sometimes repeats a committed segment as a partial right after it.
        if (this.echoesLastCommit(text)) return;
        if (startsNewSegment(this.partial, text)) this.closeStalledSegment();
        if (text !== this.partial) this.watchForStall();
        this.partial = text;
        this.onPartial?.(this.partial);
        this.considerForcedCommit();
        return;
      }
      case 'committed_transcript': {
        this.onServerMessage?.(msg.message_type, msg.text || '');
        const text = (msg.text || '').trim();
        // The late commit of a segment already closed here: the partial is the next one's.
        if (this.takeLocalCommit(text)) return;
        clearTimeout(this.stallTimer);
        const pending = this.partial.trim();
        this.partial = '';
        // An empty commit right after a partial with words keeps those words.
        const final = text || (words(pending).length >= MIN_RECOVERED_WORDS ? pending : '');
        if (final) this.commit(final);
        return;
      }
      case 'commit_throttled':
        this.manualCommits = false;
        this.log('warn', `${this.name}: manual commits throttled, relying on silence detection only`);
        return;
      default:
        break;
    }
    const type = msg.message_type;
    this.onServerMessage?.(type, msg.error || msg.warning || '');
    if (FATAL.has(type)) {
      this.fail(new SttFatalError(type, msg.error));
    } else if (RECONNECT.has(type)) {
      this.log('warn', `${this.name}: ${type} ${msg.error || ''}, reconnecting`);
      try {
        this.ws?.close();
      } catch {
        // closing anyway
      }
    } else if (type) {
      this.log('info', `${this.name}: ${type} ${msg.error || msg.warning || ''}`);
    }
  }

  // Silence detection commits a segment when the speaker pauses. Finished sentences are
  // already translated from the partial transcript before that (EarlySentences), so a
  // hand commit is only a safety net for very long speech: it cuts the audio where it
  // is, which can split a word.
  considerForcedCommit() {
    if (!this.manualCommits) return;
    const text = this.partial.trim();
    if (text.length < 600 || !/[.!?…]["')\]]*$/.test(text)) return;
    if (Date.now() - this.lastForcedCommit < 3000) return;
    this.pendingCommit = true;
    this.lastForcedCommit = Date.now();
  }

  sendAudio(int16) {
    if (this.stopped) return;
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const commit = this.pendingCommit;
      this.pendingCommit = false;
      this.ws.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: int16ToBase64(int16),
          commit,
          sample_rate: 16000,
        }),
      );
    } else {
      this.backlog.push(int16);
      if (this.backlog.length > 50) this.backlog.shift();
    }
  }

  drain() {
    const queued = this.backlog;
    this.backlog = [];
    for (const chunk of queued) this.sendAudio(chunk);
  }

  watchForStall() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.closeStalledSegment(), (this.vadSilenceSecs + this.stallExtraSecs) * 1000);
  }

  closeStalledSegment() {
    clearTimeout(this.stallTimer);
    const pending = this.partial.trim();
    if (this.stopped || words(pending).length < MIN_RECOVERED_WORDS) return;
    this.log('warn', `${this.name}: no commit came for a finished segment, using its last partial`);
    this.partial = '';
    this.localCommits.push({ words: words(pending), at: Date.now() });
    this.commit(pending);
  }

  commit(text) {
    this.lastCommit = { words: words(text), at: Date.now() };
    this.onCommitted?.(text);
  }

  echoesLastCommit(text) {
    const last = this.lastCommit;
    const heard = words(text);
    return Boolean(last && heard.length && Date.now() - last.at < 3000 && lcsLength(heard, last.words) === heard.length);
  }

  // A server commit that turns up after its segment was closed here (the same words, or
  // an empty one just after) is not passed on twice.
  takeLocalCommit(text) {
    const now = Date.now();
    this.localCommits = this.localCommits.filter((c) => now - c.at < 15000);
    const heard = words(text);
    const i = heard.length
      ? this.localCommits.findIndex((c) => lcsLength(heard, c.words) / Math.max(heard.length, c.words.length) >= 0.6)
      : this.localCommits.findIndex((c) => now - c.at < 5000);
    if (i < 0) return false;
    this.localCommits.splice(i, 1);
    return true;
  }

  retryLater(err) {
    if (this.stopped) return;
    if (!this.ready) {
      this.failedBeforeStart += 1;
      if (this.failedBeforeStart >= 2 && !this.minimal) {
        this.minimal = true;
        this.log('warn', `${this.name}: session keeps failing to start, retrying without keyterms and no_verbatim`);
      }
    }
    this.attempts += 1;
    const delay = Math.min(5000, 400 * 2 ** (this.attempts - 1));
    this.log('warn', `${this.name}: ${err?.message || err}; retrying in ${delay} ms`);
    this.setStatus('reconnecting', err?.message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  fail(error, cause) {
    this.log('error', `${this.name}: ${error.message}`, cause);
    this.stop();
    this.setStatus('failed', error.message);
    this.onFatal?.(error, cause);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.stallTimer);
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.backlog = [];
    try {
      ws?.close(1000);
    } catch {
      // already closed
    }
    if (this.status !== 'failed') this.setStatus('stopped');
  }
}

// Partials of one segment grow from the same start. A finished sentence followed by a
// partial whose first words share nothing with it means the server moved on.
function startsNewSegment(previous, next) {
  const before = words(previous);
  const after = words(next);
  if (before.length < MIN_RECOVERED_WORDS || !after.length || !/[.!?…]["'”’»)\]]*\s*$/u.test(previous)) return false;
  const head = Math.min(3, after.length);
  return lcsLength(before.slice(0, head), after.slice(0, head)) === 0;
}
