// Shared by the end-to-end suites: loads dist/ into Chromium, serves the mock Meet call
// at https://meet.google.com/ and gives the suites small helpers to drive the extension.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_HOSTS, startMockApi } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
export const dist = path.join(root, 'dist');
export const fixtures = path.join(here, 'fixtures');
export const outDir = path.join(here, 'out');

export const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadEnv() {
  const file = path.join(root, '.env');
  const env = { ...process.env };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

export function makeFixtures() {
  const wanted = {
    'english.wav': ['Samantha', 'Hi, thanks for joining the call today. I wanted to talk about the launch timeline. We are planning to open the public sale next Friday at three in the afternoon. Does that work for your team?'],
    'turkish.wav': ['Yelda', 'Merhaba, davet için teşekkürler. Cuma günü saat üç bizim için uygun. Ekibimle konuşup size e-posta ile dönüş yapacağım.'],
  };
  for (const [file, [voice, text]] of Object.entries(wanted)) {
    const wav = path.join(fixtures, file);
    if (existsSync(wav)) continue;
    const aiff = wav.replace('.wav', '.aiff');
    execFileSync('say', ['-v', voice, '-o', aiff, text]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-af', 'apad=pad_dur=2', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  }
  // The mock's certificate must name every API host; it is remade when a host is added.
  const cert = path.join(fixtures, 'mock-cert.pem');
  const names = existsSync(cert) ? execFileSync('openssl', ['x509', '-in', cert, '-noout', '-ext', 'subjectAltName']).toString() : '';
  if (!API_HOSTS.every((host) => names.includes(`DNS:${host}`))) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=api.elevenlabs.io',
      '-addext', `subjectAltName=${API_HOSTS.map((host) => `DNS:${host}`).join(',')}`,
      '-keyout', path.join(fixtures, 'mock-key.pem'), '-out', cert], { stdio: 'ignore' });
  }
  const tone = path.join(fixtures, 'tone.wav');
  if (!existsSync(tone)) {
    // Beeps rather than a steady tone: noise suppression would fade a steady tone.
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20', '-af', "volume='if(lt(mod(t,0.5),0.3),0.25,0)':eval=frame", '-ac', '1', '-c:a', 'pcm_s16le', tone]);
  }
}

// Chrome derives an unpacked extension's id from its path.
export function extensionIdFor(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export async function launch({ micWav, remoteWav, proxyPort }) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'tercuman-e2e-'));
  const id = extensionIdFor(dist);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    // Playwright mutes tab audio by default, which would also silence tab capture.
    // A fake output device keeps the test quiet on the speakers instead.
    ignoreDefaultArgs: ['--mute-audio'],
    args: [
      '--disable-audio-output',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      // Not --use-fake-ui-for-media-stream: it breaks tab capture (NotFoundError).
      // This one only auto-accepts camera and microphone prompts.
      '--auto-accept-camera-and-microphone-capture',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micWav}`,
      `--allowlisted-extension-id=${id}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(proxyPort ? [`--proxy-server=http://127.0.0.1:${proxyPort}`, '--ignore-certificate-errors'] : []),
    ],
  });
  await context.route('https://meet.google.com/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fixtures/remote.wav') return route.fulfill({ path: remoteWav, contentType: 'audio/wav' });
    return route.fulfill({ path: path.join(here, 'mock-meet.html'), contentType: 'text/html' });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const actualId = new URL(worker.url()).host;
  if (actualId !== id) throw new Error(`extension id ${actualId} differs from computed ${id}`);

  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/options.html`);
  const meet = await context.newPage();
  const pageErrors = [];
  meet.on('pageerror', (err) => pageErrors.push(err.message));
  await meet.goto('https://meet.google.com/abc-defg-hij');
  await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
  await meet.bringToFront();
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
  return { context, worker, control, meet, tabId, pageErrors, userDataDir };
}

export const send = (control, msg) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
export const sessionState = (control) => control.evaluate(async () => (await chrome.storage.session.get('state')).state);

export async function maxLevel(meet, ms) {
  return meet.evaluate(async (duration) => {
    let max = 0;
    const end = performance.now() + duration;
    while (performance.now() < end) {
      max = Math.max(max, window.__test.level());
      await new Promise((r) => setTimeout(r, 15));
    }
    return max;
  }, ms);
}

export async function waitFor(fn, timeout = 10000, every = 200) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(every);
  }
}

export const readCaptions = (meet) =>
  meet.evaluate(() => {
    const root = document.getElementById('meet-tercuman-overlay')?.shadowRoot;
    if (!root) return { incoming: [], outgoing: [] };
    const pick = (sel) =>
      [...root.querySelectorAll(`${sel} .item`)].map((el) => ({
        translation: el.querySelector('.tr')?.textContent || '',
        source: el.querySelector('.src')?.textContent || '',
      }));
    return { incoming: pick('.incoming'), outgoing: pick('.outgoing') };
  });

export const done = (list) => list.find((x) => x.translation && x.translation !== '…');

// A local stand-in for the APIs, with its TLS certificate from the fixtures.
export function startMock(options = {}) {
  return startMockApi({
    cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
    key: readFileSync(path.join(fixtures, 'mock-key.pem')),
    ...options,
  });
}

export async function closeBrowser(env) {
  await env.context.close();
  await rm(env.userDataDir, { recursive: true, force: true });
}

// Prints the tally and gives the exit code.
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length ? 1 : 0;
}
