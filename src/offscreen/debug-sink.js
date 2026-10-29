// Opt-in diagnostics for testing on this computer. When the Meet page asks for it (its
// localStorage key `meet-tercuman-debug` holds a port), the engine copies the audio it
// sends to speech recognition, what comes back, and the call recording to a server on
// that port. Only http://127.0.0.1 is ever used, so nothing leaves the computer this way.

export function debugSinkUrl(port) {
  const n = Number(port);
  return Number.isInteger(n) && n > 1023 && n < 65536 ? `http://127.0.0.1:${n}` : null;
}

export class DebugSink {
  constructor(base) {
    this.base = `${base}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.t0 = performance.now();
    this.pending = { in: [], out: [] };
    this.seq = { in: 0, out: 0 };
    this.lastArrival = { in: 0, out: 0 };
    this.maxGap = { in: 0, out: 0 };
    this.timer = setInterval(() => this.flush(), 1000);
  }

  // Exactly what went to speech recognition, plus how evenly the chunks arrived.
  pcm(dir, int16) {
    const now = performance.now();
    if (this.lastArrival[dir]) this.maxGap[dir] = Math.max(this.maxGap[dir], now - this.lastArrival[dir]);
    this.lastArrival[dir] = now;
    this.pending[dir].push(int16.slice());
  }

  event(e) {
    this.post('event', JSON.stringify({ at: Math.round(performance.now() - this.t0), ...e }));
  }

  recording(seq, blob) {
    this.post(`recording/${seq}`, blob);
  }

  flush() {
    for (const dir of ['in', 'out']) {
      const parts = this.pending[dir];
      if (!parts.length) continue;
      this.pending[dir] = [];
      const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        joined.set(p, at);
        at += p.length;
      }
      this.event({ kind: 'chunks', dir, n: parts.length, maxGapMs: Math.round(this.maxGap[dir]) });
      this.maxGap[dir] = 0;
      this.post(`pcm-${dir}/${this.seq[dir]++}`, joined.buffer);
    }
  }

  post(path, body) {
    fetch(`${this.base}/${path}`, { method: 'POST', body }).catch(() => {});
  }

  close() {
    clearInterval(this.timer);
    this.flush();
  }
}
