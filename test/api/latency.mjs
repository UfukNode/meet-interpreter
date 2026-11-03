// How long after the end of each sentence its translation starts to sound, with the real
// ElevenLabs. Turkish clips are streamed at real-time pace in 100 ms chunks, the way the
// extension streams the microphone, two ways: recognition's own silence detection alone
// (how it worked before) and the extension closing each segment itself (shared/turn.js).
// Needs ELEVENLABS_API_KEY in .env.
//
//   node test/api/latency.mjs [runs] [silence]   e.g. `2 0.5` for the 0.5 s setting
//
// The voice is VOICE (a voice id) or the account's first own clone, else its first voice.
// The translation step is a fixed English sentence after 30 ms, about what Chrome's own
// translator takes. In a call the player's 0.08 s wait and Meet's own delay come on top.

import { execFileSync } from 'node:child_process';
import { ScribeRealtime } from '../../src/offscreen/stt.js';
import { synthesize } from '../../src/offscreen/tts.js';
import { TurnEnd } from '../../src/shared/turn.js';
import { listVoices, warmConnection } from '../../src/shared/elevenlabs.js';
import { elevenLabsKey, fixture, sleep } from '../meet/tools.mjs';

const RUNS = Number(process.argv[2] || 2);
const SILENCE = Number(process.argv[3] || 0.7); // the "Silence that ends a phrase" setting
const key = elevenLabsKey();
const VOICE = process.env.VOICE || (await (async () => {
  const voices = await listVoices(key);
  return (voices.find((v) => v.category === 'cloned') || voices[0]).voice_id;
})());

const CLIPS = [
  {
    name: 'tr_long.wav',
    text: 'Merhaba, davet için teşekkür ederim. [[slnc 700]] Cuma günü saat üç bizim için uygun. [[slnc 700]] Ekibimle konuşup size e-posta ile dönüş yapacağım. [[slnc 700]] Fiyat konusunda biraz esneklik olabilir mi? [[slnc 2500]]',
  },
  {
    // Pauses inside sentences, where a segment must stay open.
    name: 'tr_pauses.wav',
    text: 'Cuma günü saat üçte [[slnc 450]] sizinle görüşebiliriz. [[slnc 1200]] Raporu hazırladım ama [[slnc 600]] birkaç rakamı kontrol etmem gerekiyor. [[slnc 1200]] Bence fiyat [[slnc 350]] biraz yüksek. [[slnc 2000]]',
  },
];

function load(file) {
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', '-f', 's16le', '-']);
  return new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}

// Speech stretches from 10 ms levels; a gap of 300 ms or more ends one.
function speechEnds(pcm) {
  const ends = [];
  let last = -1;
  let inSpeech = false;
  for (let i = 0, k = 0; i + 160 <= pcm.length; i += 160, k++) {
    let sum = 0;
    for (let j = 0; j < 160; j++) sum += pcm[i + j] * pcm[i + j];
    const loud = Math.sqrt(sum / 160) / 32768 > 0.01;
    if (loud) {
      inSpeech = true;
      last = k;
    } else if (inSpeech && k - last >= 30) {
      ends.push((last + 1) / 100);
      inSpeech = false;
    }
  }
  if (inSpeech) ends.push((last + 1) / 100);
  return ends;
}

function rms(chunk) {
  let sum = 0;
  for (const s of chunk) sum += (s / 32768) ** 2;
  return Math.sqrt(sum / chunk.length);
}

async function run(pcm, ends, local) {
  const t0 = { at: 0 };
  const now = () => (performance.now() - t0.at) / 1000;
  const turn = local ? new TurnEnd({ holdSecs: SILENCE, language: 'tr' }) : null;
  const commits = [];
  const sounds = [];
  const stt = new ScribeRealtime({
    name: 'latency',
    apiKey: key,
    languageCode: 'tr',
    // As in the engine: when the extension closes the segments, the server detects nothing.
    closesSegments: local,
    vadSilenceSecs: SILENCE,
    onPartial: (text) => {
      if (turn?.partial(text) === 'commit') stt.commitNow();
    },
    onCommitted: (text) => {
      turn?.committed();
      const at = now();
      commits.push({ at, text });
      // The translation, then the voice: when its first sound arrives.
      setTimeout(async () => {
        for await (const _ of synthesize({ apiKey: key, voiceId: VOICE, text: 'Thank you, that works for us.', modelId: 'eleven_v4_turbo', languageCode: 'en', voiceSettings: { stability: 0.5, similarity_boost: 0.8, speed: 1 } })) {
          sounds.push({ commitAt: at, at: now() });
          break;
        }
      }, 30);
    },
    log: () => {},
  });
  stt.start();
  for (let i = 0; i < 400 && stt.status !== 'ready'; i++) await sleep(25);
  warmConnection();
  await sleep(500);
  const total = Math.ceil(pcm.length / 1600) + 30;
  t0.at = performance.now();
  for (let k = 0; k < total; k++) {
    const wait = t0.at + (k + 1) * 100 - performance.now(); // a chunk is sent once its audio has been heard
    if (wait > 0) await sleep(wait);
    const chunk = new Int16Array(1600);
    if (k * 1600 < pcm.length) chunk.set(pcm.subarray(k * 1600, Math.min(pcm.length, (k + 1) * 1600)));
    if (turn?.level(rms(chunk)) === 'commit') stt.commitNow();
    stt.sendAudio(chunk);
  }
  await sleep(2500);
  stt.stop();
  // Each commit belongs to the last speech end before it.
  return commits.map((c) => {
    const end = Math.max(...ends.filter((e) => e < c.at));
    const sound = sounds.find((s) => s.commitAt === c.at);
    return { text: c.text, commitMs: Math.round((c.at - end) * 1000), soundMs: sound ? Math.round((sound.at - end) * 1000) : null };
  });
}

const median = (xs) => {
  const s = xs.filter((x) => x !== null).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

const results = { before: [], now: [] };
for (const clip of CLIPS) {
  const file = fixture(clip.name, 'Yelda', clip.text);
  const pcm = load(file);
  const ends = speechEnds(pcm);
  console.log(`\n${clip.name}: speech ends at ${ends.map((e) => `${e.toFixed(2)} s`).join(', ')}`);
  for (let r = 0; r < RUNS; r++) {
    for (const local of [false, true]) {
      const rows = await run(pcm, ends, local);
      const label = local ? 'now   ' : 'before';
      results[local ? 'now' : 'before'].push(...rows);
      console.log(`  ${label} run ${r + 1}: ${rows.length} segments`);
      for (const row of rows) console.log(`    commit +${row.commitMs} ms, first sound +${row.soundMs ?? '-'} ms  ${row.text}`);
    }
  }
}
console.log(`\nmedian from the end of a sentence, with ${SILENCE} s of silence ending a phrase:`);
for (const [label, rows] of Object.entries(results)) {
  console.log(`  ${label.padEnd(6)} commit ${median(rows.map((r) => r.commitMs))} ms, first sound ${median(rows.map((r) => r.soundMs))} ms (${rows.length} segments)`);
}
