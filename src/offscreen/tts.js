import { speechStream, ElevenLabsError, isNetworkError } from '../shared/elevenlabs.js';
import { PcmByteAligner } from '../shared/pcm.js';

// ElevenLabs limits concurrent generations per plan, and both directions of the call
// share one key, so requests wait for a free slot here instead of failing with 429.
class Semaphore {
  constructor(slots) {
    this.free = slots;
    this.waiting = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (this.free > 0) {
      this.free -= 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  release() {
    const next = this.waiting.shift();
    if (next) next.resolve(() => this.release());
    else this.free += 1;
  }
}

const slots = new Semaphore(3);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

// Yields Int16Array chunks of 24 kHz mono speech as they arrive. A busy service or a
// dropped connection is retried while none of the sentence has been heard yet; after
// that a retry would repeat its start, so the error goes up instead.
export async function* synthesize({ apiKey, signal, ...request }) {
  const release = await slots.acquire(signal);
  try {
    for (let attempt = 0; ; attempt++) {
      let heard = false;
      try {
        const response = await speechStream(apiKey, { ...request, signal });
        const reader = response.body.getReader();
        const aligner = new PcmByteAligner();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            const samples = aligner.push(value);
            if (samples.length) {
              heard = true;
              yield samples;
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
      } catch (err) {
        const retryable = (err instanceof ElevenLabsError && err.retryable) || isNetworkError(err);
        if (retryable && !heard && attempt < 3 && !signal?.aborted) {
          await sleep(350 * 2 ** attempt, signal);
          continue;
        }
        throw err;
      }
    }
  } finally {
    release();
  }
}
