import { StreamResampler } from './dsp.js';
import { int16ToFloat32 } from './pcm.js';

// Plays streamed 24 kHz PCM gap-free into an AudioNode. Each utterance has an id and
// its own resampler, so chunk boundaries never click. When the queue runs dry the
// next chunk waits `prebufferSec`, which absorbs network jitter.
export class PcmScheduler {
  constructor(ctx, destination, { inputRate = 24000, prebufferSec = 0.12, onPlayingChange } = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.inputRate = inputRate;
    this.prebufferSec = prebufferSec;
    this.onPlayingChange = onPlayingChange;
    this.sources = new Set();
    this.resamplers = new Map();
    this.nextTime = 0;
    this.playing = false;
    this.timer = null;
  }

  push(id, int16) {
    let resampler = this.resamplers.get(id);
    if (!resampler) {
      resampler = new StreamResampler(this.inputRate, this.ctx.sampleRate);
      this.resamplers.set(id, resampler);
    }
    this.schedule(resampler.process(int16ToFloat32(int16)));
  }

  end(id) {
    const resampler = this.resamplers.get(id);
    if (!resampler) return;
    this.resamplers.delete(id);
    this.schedule(resampler.flush());
  }

  schedule(samples) {
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    const now = this.ctx.currentTime;
    if (this.nextTime < now + 0.01) this.nextTime = now + this.prebufferSec;
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      this.update();
    };
    this.watch();
  }

  // Seconds of audio queued but not yet heard.
  backlog() {
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }

  flush() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
    }
    this.sources.clear();
    this.resamplers.clear();
    this.nextTime = 0;
    this.update();
  }

  watch() {
    if (!this.timer) this.timer = setInterval(() => this.update(), 100);
    this.update();
  }

  update() {
    const playing = this.sources.size > 0;
    if (playing !== this.playing) {
      this.playing = playing;
      this.onPlayingChange?.(playing);
    }
    if (!playing && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// A short two-tone chime as 24 kHz PCM, used by the connection test.
export function testChime(rate = 24000) {
  const tones = [
    { freq: 660, dur: 0.18 },
    { freq: 880, dur: 0.28 },
  ];
  const total = tones.reduce((n, t) => n + Math.round(t.dur * rate), 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const { freq, dur } of tones) {
    const n = Math.round(dur * rate);
    for (let i = 0; i < n; i++) {
      const envelope = Math.min(1, i / (0.01 * rate), (n - i) / (0.03 * rate));
      out[offset + i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * envelope * 0.35 * 32767);
    }
    offset += n;
  }
  return out;
}
