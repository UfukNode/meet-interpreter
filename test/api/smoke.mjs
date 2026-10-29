// Live check of the real APIs with the extension's own modules, with latency numbers.
// Needs ELEVENLABS_API_KEY in .env; ANTHROPIC_API_KEY is optional (without it the
// translation step uses fixed sentences and only ElevenLabs is checked).
//
//   node test/api/smoke.mjs            speech to text, translation, text to speech
//   node test/api/smoke.mjs --clone    also creates and deletes a test voice clone
//
// Audio files it produces land in test/api/out/ so you can listen to them.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVoices, createVoiceClone, deleteVoice, fetchScribeToken } from '../../src/shared/elevenlabs.js';
import { ScribeRealtime } from '../../src/offscreen/stt.js';
import { Translator } from '../../src/offscreen/translator.js';
import { synthesize } from '../../src/offscreen/tts.js';
import { Downsampler } from '../../src/shared/dsp.js';
import { concatInt16, encodeWav, float32ToInt16, int16ToFloat32 } from '../../src/shared/pcm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const out = path.join(here, 'out');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env() {
  const vars = { ...process.env };
  const file = path.join(root, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2]) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return vars;
}

const vars = env();
const EL = vars.ELEVENLABS_API_KEY;
const AN = vars.ANTHROPIC_API_KEY;
if (!EL) {
  console.error('Put ELEVENLABS_API_KEY in .env first.');
  process.exit(1);
}

const results = [];
async function step(name, fn) {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}  [${Math.round(performance.now() - started)} ms]`);
    return true;
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  (${err?.message || err})`);
    return false;
  }
}

function wavSamples(file) {
  // 16-bit mono WAV as produced by ffmpeg in the e2e fixtures.
  const buf = readFileSync(file);
  const dataAt = buf.indexOf('data') + 8;
  const rate = buf.readUInt32LE(24);
  const end = buf.length - ((buf.length - dataAt) % 2);
  return { rate, samples: new Int16Array(buf.buffer.slice(buf.byteOffset + dataAt, buf.byteOffset + end)) };
}

function speechFixture(name, voice, text) {
  const file = path.join(root, 'test/e2e/fixtures', name);
  if (!existsSync(file)) {
    const aiff = file.replace('.wav', '.aiff');
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-af', 'apad=pad_dur=2', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
  }
  return wavSamples(file);
}

async function speak(label, { voiceId, text, languageCode, modelId = 'eleven_flash_v2_5' }) {
  const started = performance.now();
  let first = 0;
  const chunks = [];
  for await (const chunk of synthesize({ apiKey: EL, voiceId, text, modelId, languageCode, voiceSettings: { stability: 0.5, similarity_boost: 0.8, speed: 1 } })) {
    if (!first) first = performance.now() - started;
    chunks.push(chunk);
  }
  const pcm = concatInt16(chunks);
  if (pcm.length < 24000 * 0.3) throw new Error(`only ${pcm.length} samples of audio came back`);
  const file = path.join(out, `${label}.wav`);
  await writeFile(file, Buffer.from(encodeWav(pcm, 24000)));
  return { first: Math.round(first), seconds: pcm.length / 24000, file, pcm };
}

async function transcribe({ samples, rate, languageCode, keyterms }) {
  const committed = [];
  let audioEnd = 0;
  let lastCommitAfterEnd = null;
  let fatal = null;
  const stt = new ScribeRealtime({
    name: `stt-${languageCode}`,
    apiKey: EL,
    languageCode,
    vadSilenceSecs: 0.7,
    keyterms,
    onCommitted: (text) => {
      committed.push(text);
      if (audioEnd) lastCommitAfterEnd = performance.now() - audioEnd;
    },
    onFatal: (err, cause) => (fatal = cause || err),
    log: (level, message) => level !== 'info' && console.log(`      ${level}: ${message}`),
  });
  const connectStarted = performance.now();
  stt.start();
  const deadline = Date.now() + 10000;
  while (stt.status !== 'ready' && !fatal && Date.now() < deadline) await sleep(20);
  if (fatal || stt.status !== 'ready') throw new Error(`did not connect: ${fatal?.message || stt.status}`);
  const connectMs = Math.round(performance.now() - connectStarted);

  // Real-time pace, 100 ms chunks at 16 kHz, exactly like the extension.
  const down = new Downsampler(rate, 16000);
  const float = int16ToFloat32(samples);
  const step = Math.round(rate / 10);
  for (let i = 0; i < float.length; i += step) {
    stt.sendAudio(float32ToInt16(down.process(float.subarray(i, i + step))));
    await sleep(100);
  }
  audioEnd = performance.now();
  for (let i = 0; i < 30; i++) {
    stt.sendAudio(new Int16Array(1600));
    await sleep(100);
  }
  const minimal = stt.minimal;
  stt.stop();
  if (!committed.length) throw new Error('nothing was committed');
  return { text: committed.join(' '), commits: committed.length, connectMs, lastCommitAfterEnd, minimal };
}

const FIXED = {
  'en>tr': 'Merhaba, bugün görüşmeye katıldığınız için teşekkürler. Çıkış takvimini konuşmak istedim.',
  'tr>en': 'Hi, thanks for the invitation. Friday at three works for us.',
};

async function translate(text, from, to, model = 'claude-opus-5-5') {
  if (!AN) return { text: FIXED[`${from}>${to}`], fixed: true };
  const translator = new Translator({ apiKey: AN, model, myLanguage: 'tr', theirLanguage: 'en', onUsage: () => {} });
  const started = performance.now();
  let first = 0;
  const pieces = [];
  for await (const piece of translator.translate({ text, from, to, history: [] })) {
    if (!first) first = performance.now() - started;
    pieces.push(piece);
  }
  return { text: pieces.join(' '), first: Math.round(first), total: Math.round(performance.now() - started) };
}

await mkdir(out, { recursive: true });
console.log(`Mode: ElevenLabs${AN ? ' + Claude' : ' only (translation uses fixed sentences)'}\n`);

let voices = [];
await step('ElevenLabs key is accepted and lists voices', async () => {
  voices = await listVoices(EL);
  const premade = voices.filter((v) => v.category === 'premade').length;
  return `${voices.length} voices, ${premade} premade`;
});
const pool = voices.filter((v) => v.category === 'premade');
const voiceA = (pool[0] || voices[0])?.voice_id;
const voiceB = (pool[1] || pool[0] || voices[0])?.voice_id;

await step('single-use token for realtime speech to text', async () => {
  const token = await fetchScribeToken(EL);
  if (!token) throw new Error('empty token');
  return 'received';
});

const english = speechFixture('english.wav', 'Samantha', 'Hi, thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at three in the afternoon. Does that work for your team?');
const turkish = speechFixture('turkish.wav', 'Yelda', 'Merhaba, davet için teşekkürler. Cuma günü saat üç bizim için uygun. Ekibimle konuşup size e-posta ile dönüş yapacağım.');

let heardEnglish = '';
await step('Scribe realtime hears the counterpart in English (with keyterms)', async () => {
  const r = await transcribe({ ...english, languageCode: 'en', keyterms: ['Fungo', 'cZAMA'] });
  heardEnglish = r.text;
  if (r.minimal) throw new Error(`only worked without keyterms/no_verbatim: "${r.text}"`);
  return `connect ${r.connectMs} ms, ${r.commits} commits, last ${Math.round(r.lastCommitAfterEnd ?? -1)} ms after speech: "${r.text}"`;
});

let heardTurkish = '';
await step('Scribe realtime hears me in Turkish', async () => {
  const r = await transcribe({ ...turkish, languageCode: 'tr', keyterms: [] });
  heardTurkish = r.text;
  return `connect ${r.connectMs} ms, ${r.commits} commits, last ${Math.round(r.lastCommitAfterEnd ?? -1)} ms after speech: "${r.text}"`;
});

let turkishOut = FIXED['en>tr'];
await step(AN ? 'Claude translates English to Turkish' : 'translation (fixed sentence, no Anthropic key)', async () => {
  const r = await translate(heardEnglish || 'Hi, thanks for joining the call today.', 'en', 'tr');
  turkishOut = r.text;
  return r.fixed ? `"${r.text}"` : `first sentence ${r.first} ms, done ${r.total} ms: "${r.text}"`;
});

let englishOut = FIXED['tr>en'];
await step(AN ? 'Claude translates Turkish to English' : 'translation back (fixed sentence)', async () => {
  const r = await translate(heardTurkish || 'Merhaba, davet için teşekkürler.', 'tr', 'en');
  englishOut = r.text;
  return r.fixed ? `"${r.text}"` : `first sentence ${r.first} ms, done ${r.total} ms: "${r.text}"`;
});

let turkishSpeech = null;
await step('Flash v2.5 speaks Turkish', async () => {
  turkishSpeech = await speak('counterpart-in-turkish', { voiceId: voiceB, text: turkishOut, languageCode: 'tr' });
  return `first audio ${turkishSpeech.first} ms, ${turkishSpeech.seconds.toFixed(1)} s of speech`;
});
await step('Flash v2.5 speaks English', async () => {
  const r = await speak('me-in-english', { voiceId: voiceA, text: englishOut, languageCode: 'en' });
  return `first audio ${r.first} ms, ${r.seconds.toFixed(1)} s of speech`;
});
await step('v4 Turbo speaks Turkish', async () => {
  const r = await speak('counterpart-in-turkish-v4', { voiceId: voiceB, text: turkishOut, languageCode: 'tr', modelId: 'eleven_v4_turbo' });
  return `first audio ${r.first} ms, ${r.seconds.toFixed(1)} s of speech`;
});

await step('the Turkish speech we made is understood again (round trip)', async () => {
  if (!turkishSpeech) throw new Error('no Turkish speech to check');
  const r = await transcribe({ samples: turkishSpeech.pcm, rate: 24000, languageCode: 'tr', keyterms: [] });
  return `"${r.text}"`;
});

if (process.argv.includes('--clone')) {
  let cloneId = null;
  await step('instant voice clone is created', async () => {
    if (!turkishSpeech) throw new Error('no sample audio');
    const sample = new Blob([readFileSync(turkishSpeech.file)], { type: 'audio/wav' });
    const created = await createVoiceClone(EL, {
      name: 'Meet Tercuman smoke test (safe to delete)',
      files: [{ blob: sample, filename: 'sample.wav' }],
      description: 'Created by the Meet Tercuman API check and deleted right after.',
    });
    cloneId = created.voice_id;
    return `voice ${cloneId}${created.requires_verification ? ', needs verification' : ''}`;
  });
  if (cloneId) {
    await step('the clone speaks', async () => {
      const r = await speak('clone-check', { voiceId: cloneId, text: 'Bu ses klonlama testidir.', languageCode: 'tr' });
      return `first audio ${r.first} ms`;
    });
    await step('the clone is deleted again', async () => {
      await deleteVoice(EL, cloneId);
      return 'deleted';
    });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Audio is in ${path.relative(root, out)}/`);
process.exit(failed.length ? 1 : 0);
