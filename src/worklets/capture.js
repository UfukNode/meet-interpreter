import { Downsampler } from '../shared/dsp.js';
import { float32ToInt16 } from '../shared/pcm.js';

// Runs on the audio thread. Mixes the input to mono, converts it to 16 kHz for speech
// recognition and posts it in fixed-size chunks with their level. While `collectRaw`
// is on it also posts the full-rate audio, which a voice clone needs.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    const targetRate = opts.targetRate || 16000;
    this.down = new Downsampler(sampleRate, targetRate);
    this.chunk = new Float32Array(Math.round((targetRate * (opts.chunkMs || 100)) / 1000));
    this.filled = 0;
    this.sumSquares = 0;
    this.count = 0;
    this.collectRaw = Boolean(opts.collectRaw);
    this.raw = [];
    this.mono = new Float32Array(128);
    this.port.onmessage = (event) => {
      if (event.data?.type === 'collect-raw') this.collectRaw = Boolean(event.data.on);
    };
  }

  process(inputs) {
    const input = inputs[0];
    const frames = input && input[0] ? input[0].length : 128;
    if (this.mono.length !== frames) this.mono = new Float32Array(frames);
    const mono = this.mono;
    if (!input || input.length === 0) {
      mono.fill(0);
    } else if (input.length === 1) {
      mono.set(input[0]);
    } else {
      const left = input[0];
      const right = input[1];
      for (let i = 0; i < frames; i++) mono[i] = 0.5 * (left[i] + right[i]);
    }

    for (let i = 0; i < frames; i++) this.sumSquares += mono[i] * mono[i];
    this.count += frames;
    if (this.collectRaw) this.raw.push(mono.slice());

    const down = this.down.process(mono);
    let offset = 0;
    while (offset < down.length) {
      const take = Math.min(down.length - offset, this.chunk.length - this.filled);
      this.chunk.set(down.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.chunk.length) this.emit();
    }
    return true;
  }

  emit() {
    const pcm = float32ToInt16(this.chunk);
    this.filled = 0;
    const rms = Math.sqrt(this.sumSquares / Math.max(1, this.count));
    this.sumSquares = 0;
    this.count = 0;
    const message = { type: 'chunk', pcm, rms };
    const transfer = [pcm.buffer];
    if (this.raw.length) {
      const total = this.raw.reduce((n, c) => n + c.length, 0);
      const joined = new Float32Array(total);
      let at = 0;
      for (const c of this.raw) {
        joined.set(c, at);
        at += c.length;
      }
      this.raw = [];
      message.raw = float32ToInt16(joined);
      message.rawRate = sampleRate;
      transfer.push(message.raw.buffer);
    }
    this.port.postMessage(message, transfer);
  }
}

registerProcessor('capture-processor', CaptureProcessor);
