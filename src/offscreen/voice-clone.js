import { concatInt16, encodeWav } from '../shared/pcm.js';

// Collects the counterpart's speech from the call (full-rate audio, silence skipped)
// until there is enough for an instant voice clone. It is only ever created after
// the user has confirmed that the counterpart agreed to it.
export class CloneCollector {
  constructor({ targetSeconds = 45, threshold = 0.012, hangoverChunks = 3 } = {}) {
    this.targetSeconds = targetSeconds;
    this.threshold = threshold;
    this.hangoverChunks = hangoverChunks;
    this.chunks = [];
    this.samples = 0;
    this.rate = 0;
    this.hang = 0;
  }

  // Returns true once enough speech has been collected.
  push(raw, rate, level) {
    this.rate = rate;
    if (level >= this.threshold) this.hang = this.hangoverChunks;
    else if (this.hang > 0) this.hang -= 1;
    else return this.full();
    this.chunks.push(raw);
    this.samples += raw.length;
    return this.full();
  }

  seconds() {
    return this.rate ? this.samples / this.rate : 0;
  }

  full() {
    return this.seconds() >= this.targetSeconds;
  }

  toWavBlob() {
    return new Blob([encodeWav(concatInt16(this.chunks), this.rate)], { type: 'audio/wav' });
  }
}
