import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Downsampler, StreamResampler, rms } from '../../src/shared/dsp.js';

const sine = (freq, rate, seconds, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

function inChunks(processor, input, sizes) {
  const parts = [];
  let at = 0;
  let k = 0;
  while (at < input.length) {
    const n = sizes[k++ % sizes.length];
    parts.push(processor.process(input.subarray(at, at + n)));
    at += n;
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const zeroCrossings = (x) => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n;
};

test('48 kHz to 16 kHz keeps a 1 kHz tone and its level', () => {
  const out = inChunks(new Downsampler(48000, 16000), sine(1000, 48000, 1), [128]);
  assert.ok(Math.abs(out.length - 16000) <= 2, `length ${out.length}`);
  const steady = out.subarray(200);
  assert.ok(Math.abs(rms(steady) - 0.5 / Math.SQRT2) < 0.01, `rms ${rms(steady)}`);
  const crossings = zeroCrossings(steady) / (steady.length / 16000);
  assert.ok(Math.abs(crossings - 2000) < 20, `crossings/s ${crossings}`);
});

test('48 kHz to 16 kHz removes content above the new Nyquist limit', () => {
  const input = sine(12000, 48000, 1);
  const out = inChunks(new Downsampler(48000, 16000), input, [128]);
  const ratio = rms(out.subarray(200)) / rms(input);
  assert.ok(ratio < 0.02, `12 kHz leaked through at ${ratio}`);
});

test('chunk boundaries do not change the downsampled signal', () => {
  const input = sine(440, 44100, 0.5);
  const whole = new Downsampler(44100, 16000).process(input);
  const pieces = inChunks(new Downsampler(44100, 16000), input, [128, 37, 500, 1, 911]);
  assert.equal(pieces.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(whole[i] - pieces[i]) < 1e-6, `sample ${i}`);
});

test('44.1 kHz input produces 16 kHz output', () => {
  const out = inChunks(new Downsampler(44100, 16000), sine(1000, 44100, 1), [128]);
  assert.ok(Math.abs(out.length - 16000) <= 2, `length ${out.length}`);
  assert.ok(Math.abs(rms(out.subarray(200)) - 0.5 / Math.SQRT2) < 0.01);
});

test('24 kHz speech audio is upsampled to 48 kHz without level loss', () => {
  const input = sine(800, 24000, 1);
  const r = new StreamResampler(24000, 48000);
  const body = inChunks(r, input, [960, 333, 4096]);
  const tail = r.flush();
  assert.ok(Math.abs(body.length + tail.length - 48000) <= 4, `length ${body.length + tail.length}`);
  assert.ok(Math.abs(rms(body.subarray(100, 47000)) - 0.5 / Math.SQRT2) < 0.01);
});

test('chunk boundaries do not change the upsampled signal', () => {
  const input = sine(300, 24000, 0.3);
  const whole = new StreamResampler(24000, 48000).process(input);
  const pieces = inChunks(new StreamResampler(24000, 48000), input, [7, 128, 1000, 2]);
  assert.equal(pieces.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(whole[i] - pieces[i]) < 1e-6, `sample ${i}`);
});
