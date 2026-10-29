// Streaming resamplers. Both keep their state between calls, so audio that arrives in
// chunks comes out exactly as if it had been processed in one piece.

// Windowed-sinc low-pass filter. `cutoff` is in cycles per input sample (0 to 0.5).
export function designLowpass(cutoff, taps) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)); // Hamming
    h[i] = sinc * window;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  return h;
}

// Down-converts to a lower rate (48 kHz to the 16 kHz speech recognition wants):
// anti-alias filter, then linear interpolation at the output instants.
export class Downsampler {
  constructor(inRate, outRate, taps = 63) {
    this.step = inRate / outRate;
    this.passthrough = Math.abs(this.step - 1) < 1e-9;
    if (this.step > 1) {
      this.fir = designLowpass((0.45 * outRate) / inRate, taps);
      this.history = new Float32Array(taps);
      this.head = 0;
    }
    this.index = -1; // index of the last filtered input sample
    this.prev = 0;
    this.t = 0; // next output instant, in input samples
    this.out = new Float32Array(0);
  }

  process(input) {
    if (this.passthrough) return input.slice();
    const maxOut = Math.ceil(input.length / this.step) + 2;
    if (this.out.length < maxOut) this.out = new Float32Array(maxOut);
    let produced = 0;
    for (let i = 0; i < input.length; i++) {
      let y = input[i];
      if (this.fir) {
        const fir = this.fir;
        const hist = this.history;
        hist[this.head] = y;
        let acc = 0;
        let k = this.head;
        for (let j = 0; j < fir.length; j++) {
          acc += fir[j] * hist[k];
          k = k === 0 ? hist.length - 1 : k - 1;
        }
        this.head = (this.head + 1) % hist.length;
        y = acc;
      }
      const n = ++this.index;
      while (this.t <= n) {
        const frac = this.t - (n - 1);
        this.out[produced++] = this.prev + (y - this.prev) * frac;
        this.t += this.step;
      }
      this.prev = y;
    }
    return this.out.slice(0, produced);
  }
}

function catmullRom(x0, x1, x2, x3, t) {
  const a = -0.5 * x0 + 1.5 * x1 - 1.5 * x2 + 0.5 * x3;
  const b = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
  const c = -0.5 * x0 + 0.5 * x2;
  return ((a * t + b) * t + c) * t + x1;
}

// Up-converts speech (24 kHz text to speech audio to the 48 kHz audio graph) with
// cubic interpolation. Call flush() at the end of an utterance to emit the tail.
export class StreamResampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.tail = new Float32Array(3); // the last three input samples seen
    this.base = 0; // global index of the first sample of the next input chunk
    this.t = 0; // next output instant, in input samples
  }

  process(input) {
    if (Math.abs(this.step - 1) < 1e-9) return input.slice();
    const work = new Float32Array(3 + input.length);
    work.set(this.tail, 0);
    work.set(input, 3);
    const origin = this.base - 3; // global index of work[0]
    const out = new Float32Array(Math.ceil((input.length + 3) / this.step) + 2);
    let produced = 0;
    for (;;) {
      const i = Math.floor(this.t);
      const w = i - origin;
      if (w + 2 >= work.length) break;
      if (w >= 1) {
        out[produced++] = catmullRom(work[w - 1], work[w], work[w + 1], work[w + 2], this.t - i);
      }
      this.t += this.step;
    }
    this.base += input.length;
    this.tail = work.slice(work.length - 3);
    return out.slice(0, produced);
  }

  flush() {
    return this.process(new Float32Array(3));
  }
}

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}
