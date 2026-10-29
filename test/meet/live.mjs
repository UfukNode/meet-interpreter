// Live test on a real Google Meet call, recorded to a video.
//
//   node test/meet/live.mjs https://meet.google.com/abc-defg-hij
//
// Two test participants join the call as guests, and the host admits them:
//   "EN test"                  speaks English (fake microphone), no extension
//   "TR test (Meet Tercüman)"  speaks Turkish (fake microphone), runs the extension
// Speech recognition and speech are the real ElevenLabs (ELEVENLABS_API_KEY in .env).
// Translation is the real Claude when ANTHROPIC_API_KEY is set; otherwise the
// extension's Claude requests are answered by Chrome's own on-device translator,
// running in the installed Google Chrome, through the local test proxy.
//
// Timeline: they speak, I listen (English to Turkish); I speak, they listen (Turkish
// to English); I mute in Meet and nothing may reach them. The output is
// test/meet/out/meet-test.mp4: both screens side by side with what each side heard.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from '../e2e/mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const out = path.join(here, 'out');
const fixtures = path.join(root, 'test/e2e/fixtures');
// Accepts meet.google.com/abc-defg-hij and meet.google.com/meet/abc-defg-hij.
const meetCode = (process.argv[2] || '').match(/meet\.google\.com\/(?:meet\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1];
if (!meetCode) {
  console.error('Usage: node test/meet/live.mjs https://meet.google.com/abc-defg-hij');
  process.exit(1);
}
const meetUrl = `https://meet.google.com/${meetCode}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(5)} s]`, ...args);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

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

// ---- Chrome's own translator as the translation step (no key needed) ----------------------

async function chromeTranslatorBridge() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'meet-bridge-'));
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
  log('Chrome translator ready (installed Google Chrome, on-device)');
  return {
    translate: (text, from, to) => page.evaluate(([t, f, d]) => window.__tr[`${f}>${d}`].translate(t), [text, from, to]),
    close: async () => {
      await ctx.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

// ---- Meet participants --------------------------------------------------------------------

async function participant({ name, micWav, extension = false, proxyPort, videoDir }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'meet-bot-'));
  const id = extensionIdFor(dist);
  const args = [
    '--auto-accept-camera-and-microphone-capture',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${micWav}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-audio-output',
  ];
  if (extension) args.push(`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, `--allowlisted-extension-id=${id}`);
  if (proxyPort) args.push(`--proxy-server=http://127.0.0.1:${proxyPort}`, '--ignore-certificate-errors');
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    ignoreDefaultArgs: ['--mute-audio'],
    args,
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  // Records what this participant receives from the call (the other side's voice).
  await ctx.addInitScript(() => {
    const tracks = [];
    window.__heard = { tracks, recorder: null, chunks: [], startedAt: 0 };
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Native, {
      construct(target, argList) {
        const pc = Reflect.construct(target, argList);
        pc.addEventListener('track', (e) => {
          if (e.track.kind !== 'audio') return;
          tracks.push(e.track);
          window.__heard.connect?.(e.track);
        });
        return pc;
      },
    });
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const pageStartedAt = Date.now();
  return { ctx, page, profile, id, name, pageStartedAt };
}

async function shot(page, label) {
  await page.screenshot({ path: path.join(out, `${label}.png`) }).catch(() => {});
}

async function joinMeet(p, { muteMic }) {
  const { page, name } = p;
  await page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
  // Meet first asks whether to use the microphone and camera.
  const useDevices = page.getByRole('button', { name: /use microphone and camera/i }).first();
  await useDevices.waitFor({ timeout: 15000 }).catch(() => {});
  if (await useDevices.isVisible().catch(() => false)) await useDevices.click().catch(() => {});
  const nameBox = page.locator('input[aria-label="Your name"], input[placeholder="Your name"]').first();
  await nameBox.waitFor({ timeout: 45000 }).catch(() => {});
  await shot(page, `${p.label}-1-prejoin`);
  const body = await page.textContent('body').catch(() => '');
  if (/can't join this video call|you can't join|sign in to join/i.test(body || '')) throw new Error(`${name}: Meet does not let guests join this call (${(body || '').slice(0, 120)})`);
  if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(name);
  const camera = page.locator('[role="button"][aria-label*="camera" i][data-is-muted="false"], button[aria-label*="camera" i][data-is-muted="false"]').first();
  if (await camera.isVisible().catch(() => false)) await camera.click().catch(() => {});
  if (muteMic) {
    const mic = page.locator('[role="button"][aria-label*="microphone" i][data-is-muted="false"], button[aria-label*="microphone" i][data-is-muted="false"]').first();
    if (await mic.isVisible().catch(() => false)) await mic.click().catch(() => {});
  }
  const join = page.getByRole('button', { name: /^(ask to join|join now|join)$/i }).first();
  await join.waitFor({ timeout: 30000 });
  await join.click();
  log(`${name}: asked to join, waiting for the host to admit`);
  await page.locator('button[aria-label*="Leave call" i], [role="button"][aria-label*="Leave call" i]').first().waitFor({ timeout: 240000 });
  log(`${name}: in the call`);
  for (const label of ['Got it', 'Dismiss', 'Close']) {
    const b = page.getByRole('button', { name: label }).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }
  await shot(page, `${p.label}-2-in-call`);
}

async function setMic(page, on) {
  const button = page.locator('button[aria-label*="microphone" i][data-is-muted], [role="button"][aria-label*="microphone" i][data-is-muted]').first();
  const state = await button.getAttribute('data-is-muted', { timeout: 5000 }).catch(() => null);
  if (state === null) throw new Error('Meet microphone button not found');
  if ((state === 'true') === !on) return;
  await button.click();
  await sleep(500);
  log(`microphone ${on ? 'on' : 'off'} (${await button.getAttribute('aria-label').catch(() => '?')})`);
}

async function startHeardRecorder(page) {
  return page.evaluate(() => {
    const h = window.__heard;
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const seen = new Set();
    h.connect = (track) => {
      if (seen.has(track)) return;
      seen.add(track);
      ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
    };
    h.tracks.forEach(h.connect);
    h.recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    h.recorder.ondataavailable = (e) => e.data.size && h.chunks.push(e.data);
    h.recorder.start(1000);
    h.startedAt = Date.now();
    return h.startedAt;
  });
}

async function stopRecorder(target, expr) {
  return target.evaluate(async (path) => {
    const h = path.split('.').reduce((o, k) => o[k], globalThis);
    await new Promise((resolve) => {
      h.recorder.onstop = resolve;
      h.recorder.stop();
    });
    const blob = new Blob(h.chunks, { type: 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(binary), startedAt: h.startedAt };
  }, expr);
}


// The offscreen document that plays what the TR participant hears is not a Playwright
// page; it is reached through the DevTools protocol instead.
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

const STOP_RECORDER = (name) => `(async () => {
  const h = globalThis.${name};
  await new Promise((resolve) => { h.recorder.onstop = resolve; h.recorder.stop(); });
  const bytes = new Uint8Array(await new Blob(h.chunks, { type: 'audio/webm' }).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { b64: btoa(binary), startedAt: h.startedAt };
})()`;

// ---- run ----------------------------------------------------------------------------------

const vars = env();
if (!vars.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY missing in .env');
if (!existsSync(path.join(dist, 'manifest.json'))) throw new Error('Run npm run build first.');
await mkdir(out, { recursive: true });
const videoDir = await mkdtemp(path.join(os.tmpdir(), 'meet-video-'));

const english = fixture('en_long.wav', 'Samantha', 'Hi, thanks for joining the call today. [[slnc 700]] I wanted to talk about the launch timeline. [[slnc 700]] We are planning to open the public sale next Friday at three in the afternoon. [[slnc 700]] Does that work for your team? [[slnc 2500]]');
const turkish = fixture('tr_long.wav', 'Yelda', 'Merhaba, davet için teşekkür ederim. [[slnc 700]] Cuma günü saat üç bizim için uygun. [[slnc 700]] Ekibimle konuşup size e-posta ile dönüş yapacağım. [[slnc 700]] Fiyat konusunda biraz esneklik olabilir mi? [[slnc 2500]]');

const realClaude = Boolean(vars.ANTHROPIC_API_KEY);
const bridge = realClaude ? null : await chromeTranslatorBridge();
const mock = realClaude
  ? null
  : await startMockApi({
      cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
      key: readFileSync(path.join(fixtures, 'mock-key.pem')),
      mockOnly: ['api.anthropic.com'],
      translator: (text, from, to) => bridge.translate(text, from, to),
    });

const en = await participant({ name: 'EN test', micWav: english, videoDir });
en.label = 'en';
const tr = await participant({ name: 'TR test (Meet Tercüman)', micWav: turkish, extension: true, proxyPort: mock?.port, videoDir });
tr.label = 'tr';
const timeline = [];
let failed = null;

try {
  let [worker] = tr.ctx.serviceWorkers();
  if (!worker) worker = await tr.ctx.waitForEvent('serviceworker');
  const control = await tr.ctx.newPage();
  await control.goto(`chrome-extension://${tr.id}/options.html`);
  await control.evaluate(async (k) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(settings || {}), uiLanguage: 'tr', elevenLabsKey: k.el, anthropicKey: k.an || 'bridge', claudeModel: 'claude-opus-5-5', incomingMode: 'voice', outgoingMode: 'voice' },
    });
  }, { el: vars.ELEVENLABS_API_KEY, an: vars.ANTHROPIC_API_KEY || '' });
  await tr.page.bringToFront();

  await Promise.all([joinMeet(en, { muteMic: false }), joinMeet(tr, { muteMic: true })]);
  await setMic(en.page, false);
  await setMic(tr.page, false);

  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  const started = await control.evaluate((t) => chrome.runtime.sendMessage({ type: 'start', tabId: t, options: { incomingMode: 'voice', outgoingMode: 'voice' } }), tabId);
  if (!started?.ok) throw new Error(`extension did not start: ${started?.error}`);
  log('extension: translation started in the TR participant');

  const engine = await engineTarget(tr.ctx, tr.page);
  const trHeardStart = await engine.evaluate(`(() => {
    const s = globalThis.__tercuman.session;
    const dest = s.ctx.createMediaStreamDestination();
    s.originalGain.connect(dest);
    s.translationGain.connect(dest);
    const rec = { recorder: new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' }), chunks: [], startedAt: Date.now() };
    rec.recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
    rec.recorder.start(1000);
    globalThis.__liveRec = rec;
    return rec.startedAt;
  })()`);
  const enHeardStart = await startHeardRecorder(en.page);

  const status = async () => (await control.evaluate(async () => (await chrome.storage.session.get('state')).state))?.engine;
  const watcher = setInterval(async () => {
    const s = await status().catch(() => null);
    if (s) timeline.push({ t: Date.now() - T0, muted: s.page?.muted, senders: s.page?.senders, stt: s.stt, latency: s.latencyMs, usage: s.usage, error: s.error });
  }, 1000);

  log('phase 1: EN speaks English, TR listens in Turkish');
  await setMic(en.page, true);
  await sleep(36000);
  await shot(tr.page, 'tr-3-listening');
  await setMic(en.page, false);

  log('phase 2: TR speaks Turkish, EN hears English');
  await setMic(tr.page, true);
  await sleep(36000);
  await shot(tr.page, 'tr-4-speaking');
  await shot(en.page, 'en-4-hearing');

  log('phase 3: TR mutes in Meet, nothing may reach EN');
  await setMic(tr.page, false);
  await sleep(10000);
  clearInterval(watcher);

  const enHeard = await stopRecorder(en.page, '__heard');
  const trHeard = await engine.evaluate(STOP_RECORDER('__liveRec'));
  await writeFile(path.join(out, 'en-heard.webm'), Buffer.from(enHeard.b64, 'base64'));
  await writeFile(path.join(out, 'tr-heard.webm'), Buffer.from(trHeard.b64, 'base64'));
  const captions = await tr.page.evaluate(() => {
    const r = document.getElementById('meet-tercuman-overlay')?.shadowRoot;
    const pick = (sel) => [...(r?.querySelectorAll(`${sel} .item`) || [])].map((el) => `${el.querySelector('.src')?.textContent} => ${el.querySelector('.tr')?.textContent}`);
    return { incoming: pick('.incoming'), outgoing: pick('.outgoing') };
  });
  await writeFile(path.join(out, 'timeline.json'), JSON.stringify({ captions, timeline, trHeardStart, enHeardStart }, null, 2));
  log('captions on the TR panel:', JSON.stringify(captions, null, 1));
  await control.evaluate(() => chrome.runtime.sendMessage({ type: 'stop' }));
} catch (err) {
  failed = err;
  log('FAILED:', err.message);
  await shot(en.page, 'en-error');
  await shot(tr.page, 'tr-error');
} finally {
  const enVideo = await en.page.video()?.path();
  const trVideo = await tr.page.video()?.path();
  await en.ctx.close().catch(() => {});
  await tr.ctx.close().catch(() => {});
  await bridge?.close();
  mock?.close();
  for (const p of [en, tr]) await rm(p.profile, { recursive: true, force: true });

  if (enVideo && existsSync(enVideo)) execFileSync('cp', [enVideo, path.join(out, 'en-screen.webm')]);
  if (trVideo && existsSync(trVideo)) execFileSync('cp', [trVideo, path.join(out, 'tr-screen.webm')]);
  if (!failed && enVideo && trVideo) {
    // Line everything up on the TR participant's clock and put the two screens side by side.
    const { trHeardStart, enHeardStart } = JSON.parse(readFileSync(path.join(out, 'timeline.json'), 'utf8'));
    const base = Math.min(en.pageStartedAt, tr.pageStartedAt);
    const off = (t) => ((t - base) / 1000).toFixed(2);
    const skip = Math.max(0, (trHeardStart - base) / 1000 - 3).toFixed(2); // start just before the translation
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y',
      '-itsoffset', off(tr.pageStartedAt), '-i', trVideo,
      '-itsoffset', off(en.pageStartedAt), '-i', enVideo,
      '-itsoffset', off(trHeardStart), '-i', path.join(out, 'tr-heard.webm'),
      '-itsoffset', off(enHeardStart), '-i', path.join(out, 'en-heard.webm'),
      '-filter_complex',
      '[0:v]scale=960:540,setsar=1[l];[1:v]scale=960:540,setsar=1[r];[l][r]hstack=inputs=2[v];[2:a][3:a]amix=inputs=2:normalize=0:duration=longest[a]',
      '-map', '[v]', '-map', '[a]', '-ss', skip, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest',
      path.join(out, 'meet-test.mp4'),
    ]);
    log(`video: ${path.relative(root, path.join(out, 'meet-test.mp4'))} (left: TR with the extension, right: EN)`);
  }
  await rm(videoDir, { recursive: true, force: true }).catch(() => {});
  process.exit(failed ? 1 : 0);
}
