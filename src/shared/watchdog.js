// Gives up on a request that goes quiet. Speech plays in the order it was said, so one
// translation or one sentence of speech that never finishes would hold up everything
// queued after it for the rest of the call.
//
// The watchdog aborts its signal when nothing has happened for `ms` (each poke() starts
// the wait again), and whenever `signal` aborts.
export class Watchdog {
  constructor(signal, ms) {
    this.ms = ms;
    this.fired = false;
    this.source = signal;
    this.controller = new AbortController();
    this.follow = () => this.controller.abort(signal.reason);
    if (signal?.aborted) this.follow();
    else signal?.addEventListener('abort', this.follow, { once: true });
    this.poke();
  }

  get signal() {
    return this.controller.signal;
  }

  poke() {
    clearTimeout(this.timer);
    if (this.controller.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort(new DOMException('no answer in time', 'TimeoutError'));
    }, this.ms);
  }

  done() {
    clearTimeout(this.timer);
    this.source?.removeEventListener('abort', this.follow);
  }

  // Yields what `iterable` yields, poking on each value, and throws the moment the signal
  // aborts, even when the source never notices it.
  async *guard(iterable) {
    const signal = this.controller.signal;
    const aborted = new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      for (;;) {
        const { value, done } = await Promise.race([iterator.next(), aborted]);
        if (done) return;
        this.poke();
        yield value;
      }
    } finally {
      Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }
}
