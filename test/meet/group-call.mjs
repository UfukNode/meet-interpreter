// A four-person call with the real services, in a stand-in Meet page:
//
//   node test/meet/group-call.mjs        (npm run build first)
//
// Three people speak English with different voices and accents (American, British,
// Indian), and I speak Turkish. Speech recognition and speech are the real ElevenLabs
// (ELEVENLABS_API_KEY in .env); translation is Chrome's own on-device translator in the
// installed Google Chrome, answering the extension's Claude requests through the local
// test proxy. The extension runs as it is; only Meet is a stand-in (test/meet/group-meet.html).
//
// The call: they take turns, two of them talk over each other, I answer, I mute and say
// something that must not reach them, the panel switches their side to subtitles and
// back, Meet's captions come and go under the subtitles. Output in test/meet/out/group/.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockApi } from '../e2e/mock-api.mjs';
import { root, dist, out as outRoot, fixtures, sleep, elevenLabsKey, fixture, extensionIdFor, chromeTranslatorBridge, engineTarget, WATCH_CAPTIONS, transcribe } from './tools.mjs';

const T0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(5)} s]`, ...args);
const out = path.join(outRoot, 'group');
const key = elevenLabsKey();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// What each person says. The pauses are where a speaker would breathe between sentences.
const LINES = {
  Sarah: ['Samantha', 'Good morning everyone, and thanks for making time today. [[slnc 900]] I would like to walk you through the launch plan step by step. [[slnc 900]] Could you confirm the budget by Thursday afternoon? [[slnc 1200]]'],
  James: ['Daniel', 'We moved the public sale to next Friday at three in the afternoon. [[slnc 900]] The marketing team needs the final banner a day before. [[slnc 1200]]'],
  Ravi: ['Rishi', 'Quick question from my side. [[slnc 700]] Will the recording of this meeting be shared with the whole team? [[slnc 1200]]'],
  'Sarah-sorry': ['Samantha', 'Sorry, please go ahead. [[slnc 600]]'],
  'James-you-first': ['Daniel', 'No no, you first. [[slnc 600]]'],
  'James-thanks': ['Daniel', 'Perfect, thank you. [[slnc 500]] That works for us. [[slnc 1200]]'],
  'Ravi-subtitles': ['Rishi', 'I have one more request about the pricing page. [[slnc 700]] Please send the new numbers to the whole sales team. [[slnc 1200]]'],
  'Sarah-bye': ['Samantha', "Great, let's wrap up here and talk again next week. [[slnc 1200]]"],
};
// My microphone, from the start of the translation: silence, my answer, silence, then a
// sentence said while I am muted.
const MY_ANSWER_AT = 44;
const MY_MUTED_AT = 68;
const myAnswer = fixture('group-me.wav', 'Yelda', 'Günaydın, toplantı için teşekkür ederim. [[slnc 900]] Bütçeyi perşembe öğleden sonraya kadar onaylayabilirim. [[slnc 900]] Sunumu da yarın sabah göndereceğim. [[slnc 1500]]');
const myMuted = fixture('group-me-muted.wav', 'Yelda', 'Bu cümle karşı tarafa gitmemeli, çünkü mikrofonum kapalı. [[slnc 1500]]');

const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

await mkdir(out, { recursive: true });
const clips = Object.fromEntries(Object.entries(LINES).map(([name, [voice, text]]) => [name, fixture(`group-${name}.wav`, voice, text)]));
const mic = path.join(out, 'my-microphone.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', myAnswer, '-i', myMuted, '-filter_complex',
  `[0]adelay=${MY_ANSWER_AT * 1000}:all=1[a];[1]adelay=${MY_MUTED_AT * 1000}:all=1[b];[a][b]amix=inputs=2:duration=longest:normalize=0,apad=pad_dur=40`,
  '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', mic]);

const bridge = await chromeTranslatorBridge();
log('Chrome translator ready (installed Chrome, on-device)');
const mock = await startMockApi({
  cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
  key: readFileSync(path.join(fixtures, 'mock-key.pem')),
  mockOnly: ['api.anthropic.com'],
  translator: (text, from, to) => bridge.translate(text, from, to),
});
const id = extensionIdFor(dist);
const profile = await mkdtemp(path.join(os.tmpdir(), 'group-call-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  ignoreDefaultArgs: ['--mute-audio'],
  viewport: { width: 1280, height: 760 },
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--allowlisted-extension-id=${id}`,
    '--auto-accept-camera-and-microphone-capture',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${mic}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-audio-output',
    `--proxy-server=http://127.0.0.1:${mock.port}`,
    '--ignore-certificate-errors',
  ],
});

let exitCode = 0;
try {
  await ctx.route('https://meet.google.com/**', (route) => {
    const url = new URL(route.request().url());
    const clip = url.pathname.match(/^\/__fixtures\/(.+)\.wav$/)?.[1];
    if (clip) return route.fulfill({ path: clips[decodeURIComponent(clip)], contentType: 'audio/wav' });
    return route.fulfill({ path: path.join(root, 'test/meet/group-meet.html'), contentType: 'text/html' });
  });
  let [worker] = ctx.serviceWorkers();
  if (!worker) worker = await ctx.waitForEvent('serviceworker');
  const control = await ctx.newPage();
  await control.goto(`chrome-extension://${id}/options.html`);
  await control.evaluate(async (k) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), uiLanguage: 'tr', elevenLabsKey: k, anthropicKey: 'bridge', claudeModel: 'claude-opus-5-5', incomingMode: 'voice', outgoingMode: 'voice' } });
  }, key);
  const meet = await ctx.newPage();
  await meet.goto(`https://meet.google.com/abc-defg-hij?people=${Object.keys(LINES).join(',')}`);
  await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
  await meet.bringToFront();
  await meet.evaluate(() => window.__test.mute(true));
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  const started = await control.evaluate((t) => chrome.runtime.sendMessage({ type: 'start', tabId: t, options: { incomingMode: 'voice', outgoingMode: 'voice' } }), tabId);
  if (!started?.ok) throw new Error(`start failed: ${started?.error}`);
  const startedAt = Date.now();
  const at = (s) => sleep(Math.max(0, startedAt + s * 1000 - Date.now()));
  const engine = await engineTarget(ctx, control);
  // Caption times count from here; everything else from the start.
  const watchAt = (Date.now() - startedAt) / 1000;
  await engine.evaluate(WATCH_CAPTIONS);
  // Every speech request with its direction and time, to see what subtitle mode asks for.
  await engine.evaluate(`(() => {
    const s = globalThis.__tercuman.session;
    const t0 = performance.now() - ${Date.now() - startedAt};
    const speak = s.speak.bind(s);
    globalThis.__speech = [];
    s.speak = (item, dir) => {
      globalThis.__speech.push({ at: performance.now() - t0, dir, text: item.text });
      return speak(item, dir);
    };
    return true;
  })()`);
  for (let i = 0; i < 100 && (await engine.evaluate('globalThis.__tercuman.session.stt.in')) !== 'ready'; i++) await sleep(100);
  log('translation started, speech recognition ready');

  const said = [];
  const say = async (name) => {
    said.push({ name, at: (Date.now() - startedAt) / 1000, until: (Date.now() - startedAt) / 1000 + seconds(clips[name]) });
    log(`${name.split('-')[0]} speaks`);
    await meet.evaluate((n) => window.__test.say(n), name);
  };
  const shot = (name) => meet.screenshot({ path: path.join(out, `${name}.png`) });

  await at(4);
  await say('Sarah');
  await at(14);
  await shot('1-sarah-subtitles');
  await at(19);
  await meet.evaluate(() => window.__test.captions(true));
  await say('James');
  await at(26);
  await shot('2-above-meet-captions');
  const placed = await meet.evaluate(() => {
    const bar = document.getElementById('meet-tercuman-subtitles')?.shadowRoot?.querySelector('.bar')?.getBoundingClientRect();
    const region = document.getElementById('captions').getBoundingClientRect();
    return bar && bar.height ? { barBottom: Math.round(bar.bottom), captionsTop: Math.round(region.top) } : null;
  });
  check('the subtitles sit above Meet\'s own captions', placed && placed.barBottom <= placed.captionsTop, JSON.stringify(placed));
  await meet.evaluate(() => window.__test.captions(false));
  await at(31);
  await say('Ravi');
  await at(39);
  // Two people talk over each other.
  await Promise.all([say('Sarah-sorry'), say('James-you-first')]);
  await at(MY_ANSWER_AT - 1);
  log('I unmute and answer in Turkish');
  await meet.evaluate(() => window.__test.mute(false));
  await at(MY_ANSWER_AT + seconds(myAnswer) + 2);
  await say('James-thanks');
  await at(MY_MUTED_AT - 2);
  log('I mute, then say something that must not reach them');
  await meet.evaluate(() => window.__test.mute(true));
  const mutedLevel = await meet.evaluate(async (ms) => {
    await new Promise((r) => setTimeout(r, 1500)); // what was already playing ends
    let max = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      max = Math.max(max, window.__test.level());
      await new Promise((r) => setTimeout(r, 20));
    }
    return max;
  }, (seconds(myMuted) + 2) * 1000);
  check('nothing reaches them while I am muted', mutedLevel < 0.005, `level ${mutedLevel.toFixed(4)}`);

  // Their side to subtitles only, with a real click on the panel.
  await meet.locator('#meet-tercuman-overlay .headline').click();
  await meet.locator('#meet-tercuman-overlay .incoming .seg-btn').nth(1).click();
  const switchedAt = (Date.now() - startedAt) / 1000;
  log('their side switched to subtitles from the panel');
  await sleep(1500);
  await say('Ravi-subtitles');
  await sleep(seconds(clips['Ravi-subtitles']) * 1000 + 2500);
  await shot('3-panel-subtitles-mode');
  await meet.locator('#meet-tercuman-overlay .incoming .seg-btn').nth(0).click();
  const backAt = (Date.now() - startedAt) / 1000;
  log('back to voice');
  await meet.locator('#meet-tercuman-overlay .icon:not(.open):not(.stop)').click();
  await sleep(1000);
  await say('Sarah-bye');
  await sleep(seconds(clips['Sarah-bye']) * 1000 + 4000);
  await shot('4-end');

  const captions = (await engine.evaluate('globalThis.__captions')).map((c) => ({ ...c, at: c.at + watchAt * 1000 }));
  const speech = await engine.evaluate('globalThis.__speech');
  const state = await control.evaluate(async () => (await chrome.storage.session.get('state')).state?.engine);
  await writeFile(path.join(out, 'far-end-heard.webm'), Buffer.from(await meet.evaluate(() => window.__test.recording()), 'base64'));
  await control.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));

  console.log('\nWhat the engine did (seconds since the start):');
  for (const c of captions) {
    const when = `${(c.at / 1000).toFixed(1).padStart(5)} s  ${c.dir === 'in' ? 'they' : 'me  '}`;
    if (c.phase === 'committed') console.log(`${when}  heard       ${c.source}`);
    else if (c.phase === 'translated') console.log(`${when}  translated  ${c.translation}  (${c.translateMs} ms)`);
    else if (!c.phase.startsWith('via-')) console.log(`${when}  ${c.phase.padEnd(11)} ${c.error || c.source || ''}`);
  }
  const heard = captions.filter((c) => c.phase === 'committed');
  const theirs = heard.filter((c) => c.dir === 'in').map((c) => c.source).join(' ');
  const mine = heard.filter((c) => c.dir === 'out').map((c) => c.source).join(' ');
  const translated = captions.filter((c) => c.phase === 'translated');
  const errors = captions.filter((c) => c.phase === 'error' || c.phase === 'speech-error');

  // Who said what, in the order they said it.
  const order = ['budget', 'Friday', 'recording', 'Perfect', 'pricing', 'wrap'];
  const positions = order.map((word) => theirs.search(new RegExp(word, 'i')));
  check('every speaker is heard', positions.every((p) => p >= 0), order.map((w, i) => `${w}:${positions[i]}`).join(' '));
  check('and in the order they spoke', positions.every((p, i) => i === 0 || p > positions[i - 1]));
  check('what they say comes out in Turkish', translated.filter((c) => c.dir === 'in').length >= 8 && translated.filter((c) => c.dir === 'in').every((c) => /[çğıöşüÇĞİÖŞÜ]|\b(ve|bir|bu|için)\b/.test(c.translation)), `${translated.filter((c) => c.dir === 'in').length} lines`);
  check('my Turkish is heard', /bütçe/i.test(mine) && /sunum/i.test(mine), mine.slice(0, 160));
  check('the sentence I said while muted is not heard at all', !/gitmemeli|mikrofonum/i.test(mine), mine.slice(-120));
  const textOnly = speech.filter((s) => s.dir === 'in' && s.at / 1000 > switchedAt + 1 && s.at / 1000 < backAt);
  check('in subtitle mode no speech is asked for their side', textOnly.length === 0, JSON.stringify(textOnly.map((s) => s.text)));
  const subtitleLines = translated.filter((c) => c.dir === 'in' && c.at / 1000 > switchedAt && c.at / 1000 < backAt + 2);
  check('but their words are still translated for the subtitles', subtitleLines.length > 0, `${subtitleLines.length} lines`);
  check('no translation or speech failed', errors.length === 0, errors.map((e) => e.error).join(' | '));
  check('the engine reported no error', !state?.error, state?.error || '');

  // From the end of each English turn to the first Turkish sound for it.
  const firstAudio = speech.filter((s) => s.dir === 'in');
  console.log(`\nlatency (commit to first audio, last 8) ${state?.latencyMs} ms, usage ${JSON.stringify(state?.usage)}`);
  for (const turn of said.filter((s) => !['Ravi-subtitles'].includes(s.name))) {
    const next = firstAudio.find((s) => s.at / 1000 > turn.at + 0.5);
    if (next) console.log(`  ${turn.name.padEnd(16)} spoke ${turn.at.toFixed(1)}-${turn.until.toFixed(1)} s, first Turkish speech requested at ${(next.at / 1000).toFixed(1)} s`);
  }

  console.log('\nWhat the far end received from me, transcribed:');
  const farEnd = await transcribe(key, path.join(out, 'far-end-heard.webm'), 'en');
  for (const line of farEnd) console.log('  ', line);
  const farText = farEnd.join(' ');
  check('the far end hears my answer in English', /budget/i.test(farText) && /(presentation|slides)/i.test(farText), farText.slice(0, 160));
  check('and nothing of what I said while muted', !/(should not|shouldn't|microphone is (off|closed))/i.test(farText));
  console.log(`\nScreenshots and the far end's audio: ${path.relative(root, out)}/`);
} catch (err) {
  check('the call ran to the end', false, err.message);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) exitCode = 1;
  await ctx.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
  await bridge.close();
  mock.close();
  process.exit(exitCode);
}
