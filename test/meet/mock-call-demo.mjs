// Both directions with the real services in a stand-in Meet call, recorded by the
// extension's own call recording:
//
//   node test/meet/mock-call-demo.mjs
//
// Speech recognition and speech: the real ElevenLabs (ELEVENLABS_API_KEY in .env).
// Translation: Chrome's own on-device translator in the installed Google Chrome (the
// one free mode uses), which answers the extension's Claude requests through the local
// test proxy, with the same case fix free mode applies to it.
// The call: test/e2e/mock-meet.html, a page that does what Meet does with audio (the
// microphone goes out through a real RTCPeerConnection, the other side plays in the tab).
//
// 1. They speak English, I listen in Turkish.  2. I speak Turkish, they hear English.
// 3. I mute, nothing may reach them.  Output in test/meet/out/: the extension's
// recording (mock-call-recording.mp4) and what the far end received (far-end-heard.webm).

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from '../e2e/mock-api.mjs';
import { ScribeRealtime } from '../../src/offscreen/stt.js';
import { matchCase } from '../../src/offscreen/free-translator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const out = path.join(here, 'out');
const fixtures = path.join(root, 'test/e2e/fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(5)} s]`, ...args);

// The fake microphone starts reading its file when the translation starts. Its Turkish
// begins after this much silence, so the first part of the call has only the English.
const TURKISH_AFTER_S = 26;

const key = readFileSync(path.join(root, '.env'), 'utf8').match(/ELEVENLABS_API_KEY=(\S+)/)?.[1];
if (!key) throw new Error('ELEVENLABS_API_KEY missing in .env');

function fixture(name, voice, text) {
  const file = path.join(fixtures, name);
  if (!existsSync(file)) {
    const aiff = file.replace('.wav', '.aiff');
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-af', 'apad=pad_dur=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
  }
  return file;
}

function extensionIdFor(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function chromeTranslatorBridge() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'demo-bridge-'));
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  await ctx.route('https://translator-bridge.example/**', (r) => r.fulfill({ contentType: 'text/html', body: '<button id="go">go</button>' }));
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto('https://translator-bridge.example/');
  await page.evaluate(() => {
    window.__tr = {};
    document.getElementById('go').onclick = () => {
      window.__ready = Promise.all(
        [['en', 'tr'], ['tr', 'en']].map(async ([from, to]) => {
          // The click starts the language pack download; after that, wait until Chrome
          // reports the pack and can really create a translator (it can lag a moment).
          const options = { sourceLanguage: from, targetLanguage: to };
          Translator.create(options).catch(() => {});
          for (let attempt = 0; ; attempt++) {
            try {
              if ((await Translator.availability(options)) === 'available') {
                window.__tr[`${from}>${to}`] = await Translator.create(options);
                return;
              }
            } catch (err) {
              if (attempt > 240) throw err;
            }
            if (attempt > 240) throw new Error(`language pack ${from}>${to} never became available`);
            await new Promise((r) => setTimeout(r, 250));
          }
        }),
      );
    };
  });
  await page.click('#go');
  await page.evaluate(() => window.__ready);
  return {
    translate: async (text, from, to) => matchCase(text, await page.evaluate(([t, f, d]) => window.__tr[`${f}>${d}`].translate(t), [text, from, to]), to),
    close: async () => {
      await ctx.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

// The offscreen document that runs the engine is not a Playwright page; it is reached
// through the DevTools protocol instead.
async function engineTarget(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('offscreen document not found');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let next = 0;
  const waiting = new Map();
  cdp.on('Target.receivedMessageFromTarget', (e) => {
    if (e.sessionId !== sessionId) return;
    const msg = JSON.parse(e.message);
    waiting.get(msg.id)?.(msg);
  });
  return {
    evaluate: (expression) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        waiting.set(id, (msg) => (msg.result?.exceptionDetails ? reject(new Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text)) : resolve(msg.result?.result?.value)));
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
      }),
  };
}

// Every caption event the engine sends to the panel, with its time since the start.
const WATCH_CAPTIONS = `(() => {
  const s = globalThis.__tercuman.session;
  const t0 = performance.now();
  const original = s.caption.bind(s);
  globalThis.__captions = [];
  // Which path sent each piece to translation: a finished sentence inside a partial, the
  // last sentence after a pause, or the commit.
  for (const dir of ['in', 'out']) {
    const early = s.early[dir];
    for (const method of ['partial', 'stable', 'committed']) {
      const fn = early[method]?.bind(early);
      if (!fn) continue;
      early[method] = (text) => {
        const piece = fn(text);
        if (piece) globalThis.__captions.push({ at: performance.now() - t0, dir, phase: 'via-' + method, source: piece });
        return piece;
      };
    }
  }
  s.caption = (dir, e) => {
    if (e.phase !== 'partial' && e.phase !== 'translating') globalThis.__captions.push({ at: performance.now() - t0, dir, ...e });
    return original(dir, e);
  };
  return true;
})()`;

async function transcribe(file, languageCode) {
  const wav = file.replace(/\.\w+$/, '.wav');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const buf = readFileSync(wav);
  const dataAt = buf.indexOf('data') + 8;
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + dataAt, buf.byteOffset + buf.length - ((buf.length - dataAt) % 2)));
  const lines = [];
  const stt = new ScribeRealtime({ name: 'check', apiKey: key, languageCode, vadSilenceSecs: 0.7, onCommitted: (t) => lines.push(t), log: () => {} });
  stt.start();
  for (let i = 0; i < 400 && stt.status !== 'ready'; i++) await sleep(25);
  for (let i = 0; i < pcm.length; i += 1600) {
    stt.sendAudio(pcm.slice(i, i + 1600));
    await sleep(25);
  }
  for (let i = 0; i < 20; i++) {
    stt.sendAudio(new Int16Array(1600));
    await sleep(100);
  }
  stt.stop();
  return lines;
}

await mkdir(out, { recursive: true });
const english = fixture('en_long.wav', 'Samantha', 'Hi, thanks for joining the call today. [[slnc 700]] I wanted to talk about the launch timeline. [[slnc 700]] We are planning to open the public sale next Friday at three in the afternoon. [[slnc 700]] Does that work for your team? [[slnc 2500]]');
const turkishSpeech = fixture('tr_long.wav', 'Yelda', 'Merhaba, davet için teşekkür ederim. [[slnc 700]] Cuma günü saat üç bizim için uygun. [[slnc 700]] Ekibimle konuşup size e-posta ile dönüş yapacağım. [[slnc 700]] Fiyat konusunda biraz esneklik olabilir mi? [[slnc 2500]]');
// In Meet the tab's audio never stops (it plays the call even when nobody talks); the
// stand-in page starts from silence, so its English gets a short lead-in like that.
const englishCall = path.join(fixtures, 'en_demo.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', english, '-af', 'adelay=2000:all=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', englishCall]);
const turkish = path.join(fixtures, 'tr_demo.wav');
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', turkishSpeech, '-af', `adelay=${TURKISH_AFTER_S * 1000}:all=1,apad=pad_dur=3`, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', turkish]);
const turkishSeconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', turkishSpeech]).toString());

const bridge = await chromeTranslatorBridge();
log('Google translator ready (installed Chrome, on-device)');
const mock = await startMockApi({
  cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
  key: readFileSync(path.join(fixtures, 'mock-key.pem')),
  mockOnly: ['api.anthropic.com'],
  translator: (text, from, to) => bridge.translate(text, from, to),
});
const id = extensionIdFor(dist);
const profile = await mkdtemp(path.join(os.tmpdir(), 'demo-call-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  ignoreDefaultArgs: ['--mute-audio'],
  viewport: { width: 1280, height: 720 },
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    `--allowlisted-extension-id=${id}`,
    '--auto-accept-camera-and-microphone-capture',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${turkish}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-audio-output',
    `--proxy-server=http://127.0.0.1:${mock.port}`,
    '--ignore-certificate-errors',
  ],
});
let exitCode = 0;
const problems = [];
try {
  await ctx.route('https://meet.google.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fixtures/remote.wav') return route.fulfill({ path: englishCall, contentType: 'audio/wav' });
    return route.fulfill({ path: path.join(root, 'test/e2e/mock-meet.html'), contentType: 'text/html' });
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
  await meet.goto('https://meet.google.com/abc-defg-hij');
  await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
  await meet.bringToFront();
  await meet.evaluate(() => {
    window.__test.mute(true);
    document.getElementById('remote').loop = false;
  });
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  const started = await control.evaluate((t) => chrome.runtime.sendMessage({ type: 'start', tabId: t, options: { incomingMode: 'voice', outgoingMode: 'voice', record: true } }), tabId);
  if (!started?.ok) throw new Error(`start failed: ${started?.error}`);
  const startedAt = Date.now();
  const engine = await engineTarget(ctx, control);
  await engine.evaluate(WATCH_CAPTIONS);
  for (let i = 0; i < 100 && (await engine.evaluate('globalThis.__tercuman.session.stt.in')) !== 'ready'; i++) await sleep(100);
  log('translation and recording started, speech recognition ready');

  log('1. they speak English, my microphone is muted in the call');
  await meet.evaluate(() => document.getElementById('remote').play());
  await meet.waitForFunction(() => document.getElementById('remote').ended, null, { timeout: 60000 });
  await sleep(TURKISH_AFTER_S * 1000 - 2500 - (Date.now() - startedAt));

  log('2. I unmute and speak Turkish, they should hear English');
  await meet.evaluate(() => window.__test.mute(false));
  await sleep(2500 + turkishSeconds * 1000 + 1500);

  log('3. I mute: nothing may reach them');
  await meet.evaluate(() => window.__test.mute(true));
  const mutedLevel = await meet.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 3000)); // let what was already playing finish
    let max = 0;
    const end = performance.now() + 5000;
    while (performance.now() < end) {
      max = Math.max(max, window.__test.level());
      await new Promise((r) => setTimeout(r, 20));
    }
    return max;
  });
  log(`far end level while muted: ${mutedLevel.toFixed(4)}`);
  if (mutedLevel > 0.005) problems.push('sound reached the far end while muted');

  const captions = await engine.evaluate('globalThis.__captions');
  const state = await control.evaluate(async () => (await chrome.storage.session.get('state')).state?.engine);
  const farEnd = Buffer.from(await meet.evaluate(() => window.__test.recording()), 'base64');
  await writeFile(path.join(out, 'far-end-heard.webm'), farEnd);

  const opened = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/recording.html'), timeout: 20000 });
  await control.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
  const recordingPage = await opened;
  await recordingPage.waitForFunction(() => document.getElementById('player')?.src, null, { timeout: 15000 });
  const video = await recordingPage.evaluate(async () => {
    const blob = await (await fetch(document.getElementById('player').src)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
  const recordingFile = path.join(out, 'mock-call-recording.mp4');
  await writeFile(recordingFile, Buffer.from(video, 'base64'));

  console.log('\nWhat the engine did (seconds since the start):');
  for (const c of captions) {
    const when = `${(c.at / 1000).toFixed(1).padStart(5)} s  ${c.dir === 'in' ? 'they' : 'me  '}`;
    if (c.phase === 'committed') console.log(`${when}  heard       ${c.source}`);
    else if (c.phase === 'translated') console.log(`${when}  translated  ${c.translation}  (${c.translateMs} ms)`);
    else {
      console.log(`${when}  ${c.phase.padEnd(11)} ${c.error || c.source || ''}`);
      if (c.phase !== 'echo' && !c.phase.startsWith('via-')) problems.push(`${c.phase}: ${c.error}`);
    }
  }
  console.log(`\nlatency ${state?.latencyMs} ms, usage ${JSON.stringify(state?.usage)}, error ${state?.error || 'none'}`);
  console.log('\nWhat the far end received, transcribed (language detected):');
  for (const line of await transcribe(path.join(out, 'far-end-heard.webm'), '')) console.log('  ', line);
  console.log(`\nRecording: ${path.relative(root, recordingFile)} (${(video.length * 0.75 / 1024 / 1024).toFixed(1)} MB)`);
} catch (err) {
  problems.push(err.message);
} finally {
  for (const problem of problems) console.log('PROBLEM:', problem);
  if (problems.length) exitCode = 1;
  await ctx.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
  await bridge.close();
  mock.close();
  process.exit(exitCode);
}
