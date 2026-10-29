// Text helpers for the translation stream.

const SENTENCE_END = /[.!?…。！？]+["'”’»)\]]*(?=\s)/g;
const SOFT_BREAK = /[,;:،、]\s/g;

// Cuts a streamed translation into pieces the voice can start speaking right away:
// whole sentences, or a clause when a sentence runs long.
export class SentenceSplitter {
  constructor({ minChars = 12, softMax = 160 } = {}) {
    this.minChars = minChars;
    this.softMax = softMax;
    this.buffer = '';
  }

  push(text) {
    this.buffer += text;
    const pieces = [];
    for (;;) {
      const cut = this.findCut();
      if (cut <= 0) break;
      const piece = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '');
      if (piece) pieces.push(piece);
    }
    return pieces;
  }

  findCut() {
    SENTENCE_END.lastIndex = 0;
    let match;
    while ((match = SENTENCE_END.exec(this.buffer))) {
      const end = match.index + match[0].length;
      if (end >= this.minChars) return end;
    }
    if (this.buffer.length > this.softMax) {
      let last = -1;
      SOFT_BREAK.lastIndex = 0;
      while ((match = SOFT_BREAK.exec(this.buffer))) {
        if (match.index + 1 <= this.softMax) last = match.index + 1;
      }
      if (last >= this.minChars) return last;
    }
    return 0;
  }

  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }

  reset() {
    this.buffer = '';
  }
}

export function words(text) {
  return (
    String(text)
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}

// Length of the longest common subsequence of two word lists.
export function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return row[b.length];
}

// Remembers what we just played out loud, so that our own voice leaking back in
// (speakers instead of headphones, on either side) is not translated a second time.
// A heard text counts as an echo only when it repeats what we said, in order, and
// arrives while that audio was playing or within a few seconds after it ended.
// A real reply that reuses the same words comes later than that.
export class EchoGuard {
  constructor({ graceMs = 3500, threshold = 0.8, minWords = 3 } = {}) {
    this.graceMs = graceMs;
    this.threshold = threshold;
    this.minWords = minWords;
    this.recent = [];
  }

  remember(text, { start = Date.now(), end = start } = {}) {
    this.recent.push({ words: words(text), start, end });
    if (this.recent.length > 30) this.recent.shift();
  }

  isEcho(text, now = Date.now()) {
    const heard = words(text);
    if (heard.length < this.minWords) return false;
    const live = this.recent.filter((r) => now >= r.start && now <= r.end + this.graceMs);
    if (!live.length) return false;
    const joined = live.flatMap((r) => r.words);
    const score = lcsLength(heard, joined) / heard.length;
    return score >= this.threshold;
  }
}

export function isOnlyPunctuation(text) {
  return !/[\p{L}\p{N}]/u.test(String(text));
}

// ---- early sentences -------------------------------------------------------------------
//
// Speech recognition commits a segment only after the speaker pauses, so someone who
// talks for a minute would be translated a minute late. The partial transcript already
// carries finished sentences; once one is followed by more words and has stayed the same
// across two updates, it is sent ahead. When the segment is committed, only the part
// that was not sent ahead is translated.

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'inc', 'ltd', 'jr', 'sr', 'no', 'vb', 'bkz', 'sn', 'dk', 'yy', 'cad', 'sok']);

// Index just after the last sentence end that more words follow; 0 when there is none.
export function finishedSentenceEnd(text) {
  const re = /([\p{L}\p{N}]*)([.!?…。！？]+["'”’»)\]]*)\s+(?=\S)/gu;
  let cut = 0;
  let match;
  while ((match = re.exec(text))) {
    const word = match[1].toLocaleLowerCase();
    if (match[2][0] === '.' && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word))) continue;
    cut = match.index + match[1].length + match[2].length;
  }
  return cut;
}

function tokens(text) {
  const out = [];
  const re = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = re.exec(text))) out.push({ word: words(match[0]).join(''), end: match.index + match[0].length });
  return out;
}

// The final transcript often changes a Turkish ending ("uygundur" to "uygun"); such a
// revised word still belongs to the prefix.
const sameStem = (a, b) => Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a));

// What `text` says after the words of `prefix`. Small differences between the partial
// and the final transcript (a changed word or punctuation) are tolerated.
export function remainderAfter(prefix, text) {
  const head = words(prefix);
  if (!head.length) return text.trim();
  const toks = tokens(text);
  const textWords = toks.map((t) => t.word);
  let k = 0;
  if (head.every((w, i) => textWords[i] === w)) {
    k = head.length;
  } else {
    let best = -1;
    for (let n = 1; n <= textWords.length; n++) {
      const score = lcsLength(head, textWords.slice(0, n));
      if (score > best) {
        best = score;
        k = n;
      }
    }
    if (best < Math.ceil(head.length * 0.6)) return text.trim(); // not the same speech after all
    if (k < textWords.length && best < head.length && sameStem(textWords[k], head[head.length - 1])) k += 1;
  }
  if (k >= toks.length) return '';
  let cut = toks[k - 1].end;
  while (cut < text.length && !/[\s\p{L}\p{N}]/u.test(text[cut])) cut += 1; // keep the sentence end with the prefix
  return text.slice(cut).trim();
}

export class EarlySentences {
  constructor({ minChars = 12 } = {}) {
    this.minChars = minChars;
    this.reset();
  }

  reset() {
    this.sent = '';
    this.candidate = '';
  }

  // Text that is ready to translate now, or ''.
  partial(text) {
    const cut = finishedSentenceEnd(text);
    if (!cut) return '';
    const candidate = text.slice(0, cut);
    if (words(candidate).length <= words(this.sent).length) return '';
    // First sighting: wait for the next update to confirm it.
    if (candidate !== this.candidate) {
      this.candidate = candidate;
      return '';
    }
    const fresh = this.sent ? remainderAfter(this.sent, candidate) : candidate.trim();
    if (fresh.length < this.minChars) return '';
    this.sent = candidate;
    return fresh;
  }

  // The final transcript of the segment, minus what was already sent ahead. A final that
  // has no more words than what was sent is a revision of it ("uygundur" to "uygun"),
  // not new speech, so nothing is left to translate.
  committed(text) {
    const rest = !this.sent ? text.trim() : words(text).length <= words(this.sent).length ? '' : remainderAfter(this.sent, text);
    this.reset();
    return rest;
  }

  // The live line: only the words not sent ahead yet.
  live(text) {
    return this.sent ? remainderAfter(this.sent, text) : text;
  }
}
