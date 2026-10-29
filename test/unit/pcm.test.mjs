import { test } from 'node:test';
import assert from 'node:assert/strict';
import { int16ToBase64, base64ToInt16, PcmByteAligner, encodeWav, float32ToInt16, concatInt16 } from '../../src/shared/pcm.js';

test('base64 round trip keeps every sample', () => {
  const samples = Int16Array.from({ length: 70001 }, (_, i) => ((i * 7919) % 65536) - 32768);
  assert.deepEqual(base64ToInt16(int16ToBase64(samples)), samples);
});

test('a sample split across two network chunks is reassembled', () => {
  const samples = Int16Array.from([1, -2, 300, -32768, 32767]);
  const bytes = new Uint8Array(samples.buffer);
  const aligner = new PcmByteAligner();
  const parts = [aligner.push(bytes.subarray(0, 3)), aligner.push(bytes.subarray(3, 7)), aligner.push(bytes.subarray(7))];
  assert.deepEqual(concatInt16(parts), samples);
});

test('WAV header describes 16-bit mono PCM', () => {
  const view = new DataView(encodeWav(new Int16Array(100), 48000));
  const text = (o, n) => String.fromCharCode(...new Uint8Array(view.buffer, o, n));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 200);
});

test('float to int16 clips instead of wrapping', () => {
  assert.deepEqual([...float32ToInt16(Float32Array.from([2, -2, 0]))], [32767, -32768, 0]);
});
