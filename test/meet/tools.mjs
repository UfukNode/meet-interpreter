// Shared by the real-services call tests (mock-call-demo.mjs, group-call.mjs): test
// speech, the extension id, Chrome's own translator as the translation step, a handle on
// the offscreen engine, and a check transcription of what the far end received.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScribeRealtime } from '../../src/offscreen/stt.js';
import { matchCase } from '../../src/offscreen/free-translator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
export const dist = path.join(root, 'dist');
export const out = path.join(here, 'out');
export const fixtures = path.join(root, 'test/e2e/fixtures');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function elevenLabsKey() {
  const key = readFileSync(path.join(root, '.env'), 'utf8').match(/ELEVENLABS_API_KEY=(\S+)/)?.[1];
  if (!key) throw new Error('ELEVENLABS_API_KEY missing in .env');
  return key;
}

export function fixture(name, voice, text) {
  const file = path.join(fixtures, name);
  if (!existsSync(file)) {
    const aiff = file.replace('.wav', '.aiff');
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-af', 'apad=pad_dur=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', file]);
  }
  return file;
}

export function extensionIdFor(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export async function chromeTranslatorBridge() {
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
export async function engineTarget(ctx, page) {
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
export const WATCH_CAPTIONS = `(() => {
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

export async function transcribe(key, file, languageCode) {
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
