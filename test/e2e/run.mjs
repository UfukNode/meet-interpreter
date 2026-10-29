// End-to-end test: loads dist/ into Chromium, serves a mock Meet call at
// https://meet.google.com/ and drives the real extension.
//
//   node test/e2e/run.mjs           connection test (no API keys needed)
//   with keys in .env               also a full translation round trip
//
// The fake microphone plays a WAV file and the mock call plays another one as the
// counterpart. Test audio is made with macOS `say` and ffmpeg the first time.

import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_HOSTS, startMockApi } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(root, 'dist');
const fixtures = path.join(here, 'fixtures');
const outDir = path.join(here, 'out');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
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

function makeFixtures() {
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
function extensionIdFor(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

async function launch({ micWav, remoteWav, proxyPort }) {
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

const send = (control, msg) => control.evaluate((m) => chrome.runtime.sendMessage(m), msg);
const sessionState = (control) => control.evaluate(async () => (await chrome.storage.session.get('state')).state);

async function maxLevel(meet, ms) {
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

async function waitFor(fn, timeout = 10000, every = 200) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(every);
  }
}

async function connectionTest() {
  console.log('\n== Connection test (no API keys) ==');
  const env = await launch({ micWav: path.join(fixtures, 'tone.wav'), remoteWav: path.join(fixtures, 'english.wav') });
  const { control, meet, tabId } = env;
  try {
    check('page hook is installed in the Meet page', await meet.evaluate(() => window.__meetTercumanHook === true));
    const before = await maxLevel(meet, 1200);
    check('the far end hears the microphone before translation starts', before > 0.01, `level ${before.toFixed(3)}`);

    const start = await send(control, { type: 'start', tabId, options: { mode: 'diagnostic' } });
    check('a connection test session starts', start?.ok === true, start?.error);
    const connected = await waitFor(async () => (await sessionState(control))?.engine?.page?.connected, 8000);
    check('the engine reaches the Meet tab', Boolean(connected));
    const swapped = await waitFor(async () => (await sessionState(control))?.engine?.page?.senders > 0, 5000);
    check('the microphone sender now carries the extension track', Boolean(swapped));
    check('Meet still sees its own microphone track on the sender', await meet.evaluate(() => window.__test.senderShowsMic()));
    await sleep(400);
    const quiet = await maxLevel(meet, 800);
    check('the raw microphone no longer reaches the far end', quiet < 0.005, `level ${quiet.toFixed(4)}`);

    await send(control, { type: 'chime' });
    const chime = await maxLevel(meet, 900);
    check('a test chime reaches the far end', chime > 0.01, `level ${chime.toFixed(3)}`);

    const overlay = await meet.evaluate(() => Boolean(document.getElementById('meet-tercuman-overlay')));
    check('the panel is shown on the page', overlay);

    const engine = await waitFor(async () => {
      const e = (await sessionState(control))?.engine;
      return e && e.levels.tab > 0.005 && e.levels.mic > 0.005 ? e : null;
    }, 6000);
    const last = (await sessionState(control))?.engine;
    check('the engine hears the Meet tab (tab capture)', Boolean(engine), `tab ${last?.levels?.tab}`);
    check('the engine hears the microphone', Boolean(engine), `mic ${last?.levels?.mic}`);

    await meet.evaluate(() => window.__test.mute(true));
    const muted = await waitFor(async () => (await sessionState(control))?.engine?.page?.muted, 4000);
    check('muting in Meet is detected', Boolean(muted));
    await send(control, { type: 'chime' });
    const mutedChime = await maxLevel(meet, 900);
    check('nothing reaches the far end while muted', mutedChime < 0.005, `level ${mutedChime.toFixed(4)}`);
    await meet.evaluate(() => window.__test.mute(false));
    await waitFor(async () => (await sessionState(control))?.engine?.page?.muted === false, 4000);
    await send(control, { type: 'chime' });
    const unmutedChime = await maxLevel(meet, 900);
    check('sound reaches the far end again after unmuting', unmutedChime > 0.01, `level ${unmutedChime.toFixed(3)}`);

    const stop = await send(control, { type: 'stop' });
    check('the session stops', stop?.ok === true);
    await sleep(800);
    const after = await maxLevel(meet, 1200);
    check('the far end hears the real microphone again after stopping', after > 0.01, `level ${after.toFixed(3)}`);
    check('the panel is removed after stopping', !(await meet.evaluate(() => Boolean(document.getElementById('meet-tercuman-overlay')))));

    const withoutKeys = await send(control, { type: 'start', tabId, options: {} });
    check('translation refuses to start without API keys', withoutKeys?.ok === false && /API key|anahtar/i.test(withoutKeys?.error || ''), withoutKeys?.error);
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
  }
}


const readCaptions = (meet) =>
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

const done = (list) => list.find((x) => x.translation && x.translation !== '…');


async function recordingTest() {
  console.log('\n== Call recording (no API keys) ==');
  const env = await launch({ micWav: path.join(fixtures, 'tone.wav'), remoteWav: path.join(fixtures, 'english.wav') });
  const { context, control, meet, tabId } = env;
  try {
    const start = await send(control, { type: 'start', tabId, options: { mode: 'diagnostic', record: true } });
    check('a session with recording starts', start?.ok === true, start?.error);
    const recording = await waitFor(async () => (await sessionState(control))?.engine?.recording, 6000);
    check('the engine reports that it is recording', Boolean(recording));
    check('the panel shows the recording badge', await waitFor(() => meet.evaluate(() => {
      const r = document.getElementById('meet-tercuman-overlay')?.shadowRoot;
      return r && !r.querySelector('.rec')?.hidden;
    }), 4000));
    await sleep(1500);
    await send(control, { type: 'chime' });
    await sleep(2500);
    const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/recording.html'), timeout: 15000 });
    await send(control, { type: 'stop' });
    const page = await opened.catch(() => null);
    check('the recording page opens when the call stops', Boolean(page));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      const media = await waitFor(() => page.evaluate(() => {
        const v = document.getElementById('player');
        return v && v.readyState >= 1 ? { w: v.videoWidth, h: v.videoHeight, info: document.getElementById('info').textContent, file: document.getElementById('download').download } : null;
      }), 10000);
      check('the recording has a picture', media?.w > 0 && media?.h > 0, JSON.stringify(media));
      check('the recording can be saved as a file', /^meet-interpreter-.*\.(mp4|webm)$/.test(media?.file || ''), media?.file);
      const audio = await page.evaluate(async () => {
        const v = document.getElementById('player');
        const blob = await (await fetch(v.src)).blob();
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer()).catch(() => null);
        if (!decoded) return { seconds: 0, peak: 0, size: blob.size };
        const data = decoded.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
        return { seconds: decoded.duration, peak, size: blob.size, type: blob.type };
      });
      check('the recording holds the sound of the call', audio.seconds > 2 && audio.peak > 0.01, JSON.stringify(audio));
    }
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
  }
}

async function mockTranslationTest() {
  console.log('\n== Translation round trip against a local mock API (no keys, no cost) ==');
  const mock = await startMockApi({
    cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
    key: readFileSync(path.join(fixtures, 'mock-key.pem')),
  });
  const env = await launch({ micWav: path.join(fixtures, 'turkish.wav'), remoteWav: path.join(fixtures, 'english.wav'), proxyPort: mock.port });
  const { control, meet, tabId } = env;
  const { stats } = mock;
  try {
    await control.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), elevenLabsKey: 'mock-el', anthropicKey: 'mock-an', claudeModel: 'claude-opus-5-5' } });
    });
    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('a translation session starts', start?.ok === true, start?.error);
    if (!start?.ok) return;

    const incoming = await waitFor(async () => done((await readCaptions(meet)).incoming), 30000, 300);
    check('the counterpart is transcribed and shown in Turkish', incoming?.translation === 'Merhaba, bugün görüşmeye katıldığınız için teşekkürler.', JSON.stringify(incoming));
    const bar = await waitFor(() => meet.evaluate(() => document.getElementById('meet-tercuman-subtitles')?.shadowRoot?.textContent || ''), 5000, 200);
    check('the translation also shows as subtitles low in the Meet window', (bar || '').includes('Merhaba, bugün görüşmeye katıldığınız için teşekkürler.'), (bar || '').slice(0, 120));
    const outgoing = await waitFor(async () => done((await readCaptions(meet)).outgoing), 30000, 300);
    check('my Turkish is transcribed and shown in English', outgoing?.translation === 'Friday at three works for us.', JSON.stringify(outgoing));
    const heard = await maxLevel(meet, 4000);
    check('the far end receives my translated voice', heard > 0.01, `level ${heard.toFixed(3)}`);

    const sttLanguages = stats.stt.map((s) => s.language).sort();
    check('one Scribe session per direction, in the right languages', sttLanguages.includes('en') && sttLanguages.includes('tr'), sttLanguages.join(','));
    const ask = stats.claude[0] || {};
    check('Claude requests use Opus 5.5 at low effort with the default fallback', ask.model === 'claude-opus-5-5' && ask.effort === 'low' && ask.fallbacks === 'default' && ask.beta.includes('server-side-fallback-2026-07-01'), JSON.stringify(ask));
    const ttsIn = stats.tts.filter((t) => t.language_code === 'tr');
    const ttsOut = stats.tts.filter((t) => t.language_code === 'en');
    check('speech is requested as 24 kHz PCM in both languages', ttsIn.length > 0 && ttsOut.length > 0 && stats.tts.every((t) => t.format === 'pcm_24000'), `tr ${ttsIn.length}, en ${ttsOut.length}`);
    check('my translation uses my voice and theirs a different one', ttsOut[0]?.voice !== ttsIn[0]?.voice, `${ttsOut[0]?.voice} / ${ttsIn[0]?.voice}`);

    const status = (await sessionState(control))?.engine;
    check('latency is measured', status?.latencyMs != null, `${status?.latencyMs} ms`);
    check('usage is counted', status?.usage?.ttsChars > 0 && status?.usage?.claudeTokens > 0 && status?.usage?.sttMinutes > 0, JSON.stringify(status?.usage));
    check('the engine reported no error', !status?.error, status?.error || '');

    // Subtitles only: translations keep coming, speech requests stop.
    await send(control, { type: 'options', options: { incomingMode: 'text' } });
    await sleep(500);
    const ttsInBefore = stats.tts.filter((t) => t.language_code === 'tr').length;
    const claudeBefore = stats.claude.filter((c) => /thanks/i.test(c.utterance)).length;
    await sleep(8000);
    const ttsInAfter = stats.tts.filter((t) => t.language_code === 'tr').length;
    const claudeAfter = stats.claude.filter((c) => /thanks/i.test(c.utterance)).length;
    check('subtitle mode keeps translating the counterpart', claudeAfter > claudeBefore, `${claudeBefore} -> ${claudeAfter}`);
    check('subtitle mode asks for no speech at all', ttsInAfter === ttsInBefore, `${ttsInBefore} -> ${ttsInAfter}`);
    const saved = await control.evaluate(async () => (await chrome.storage.local.get('settings')).settings.incomingMode);
    check('the chosen mode is remembered for next time', saved === 'text', saved);

    // Muted in Meet: none of my speech is translated or sent.
    await meet.evaluate(() => window.__test.mute(true));
    await sleep(1500);
    const outBefore = stats.tts.filter((t) => t.language_code === 'en').length;
    await sleep(7000);
    const outAfter = stats.tts.filter((t) => t.language_code === 'en').length;
    const mutedLevel = await maxLevel(meet, 1000);
    check('while muted my speech is not translated', outAfter === outBefore, `${outBefore} -> ${outAfter}`);
    check('while muted nothing reaches the far end', mutedLevel < 0.005, `level ${mutedLevel.toFixed(4)}`);
    await meet.evaluate(() => window.__test.mute(false));

    // Translation to them off: they hear my real microphone again.
    await send(control, { type: 'options', options: { outgoingMode: 'off' } });
    await sleep(1500);
    const real = await maxLevel(meet, 3000);
    check('with my translation off the far end hears my real voice', real > 0.01, `level ${real.toFixed(3)}`);
    check('Meet still sees its own microphone track', await meet.evaluate(() => window.__test.senderShowsMic()));

    await send(control, { type: 'stop' });
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
    mock.close();
  }
}

async function freeTranslationTest() {
  console.log('\n== Free translation against a local mock (DeepL, Mistral, Groq; no Claude key) ==');
  const mock = await startMockApi({
    cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
    key: readFileSync(path.join(fixtures, 'mock-key.pem')),
  });
  const env = await launch({ micWav: path.join(fixtures, 'turkish.wav'), remoteWav: path.join(fixtures, 'english.wav'), proxyPort: mock.port });
  const { control, meet, tabId } = env;
  const { stats, faults } = mock;
  const setSettings = (patch) =>
    control.evaluate(async (p) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), ...p } });
    }, patch);
  const served = (from) => stats.free.slice(from).map((r) => r.service);
  try {
    // Chromium here has no language packs and the offscreen page cannot download them,
    // so with no keys the start has to explain what to do.
    await setSettings({ elevenLabsKey: 'mock-el', anthropicKey: '', claudeModel: 'free', deeplKey: '', mistralKey: '', groqKey: '' });
    const bare = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('free translation with nothing ready explains how to prepare it', bare?.ok === false && /prepare|hazırla/i.test(bare?.error || ''), bare?.error);

    await setSettings({ deeplKey: 'mock-deepl:fx', mistralKey: 'mock-mistral', groqKey: 'mock-groq' });
    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('free translation starts without an Anthropic key', start?.ok === true, start?.error);
    if (!start?.ok) return;

    const incoming = await waitFor(async () => done((await readCaptions(meet)).incoming), 30000, 300);
    check('the counterpart is translated into Turkish by DeepL first', incoming?.translation === 'Merhaba, bugün görüşmeye katıldığınız için teşekkürler.' && stats.free[0]?.service === 'deepl', `${JSON.stringify(incoming)} ${served(0).join(',')}`);
    const outgoing = await waitFor(async () => done((await readCaptions(meet)).outgoing), 30000, 300);
    const toEnglish = stats.free.find((r) => r.service === 'deepl' && r.target === 'EN-US');
    check('my Turkish is translated into English by DeepL', outgoing?.translation === 'Friday at three works for us.' && Boolean(toEnglish), JSON.stringify(outgoing));
    const heard = await maxLevel(meet, 4000);
    check('the far end receives my translated voice', heard > 0.01, `level ${heard.toFixed(3)}`);

    faults.deepl = 456;
    const atQuota = stats.free.length;
    const mistral = await waitFor(() => served(atQuota).includes('mistral'), 30000, 300);
    check('when DeepL runs out of characters, Mistral takes over by itself', mistral, served(atQuota).join(','));
    const deeplAfter = await waitFor(() => served(atQuota).filter((x) => x === 'mistral').length >= 2, 30000, 300);
    check('DeepL is not asked again after its quota error', deeplAfter && served(atQuota).filter((x) => x === 'deepl').length <= 2, served(atQuota).join(','));

    faults.mistral = 429;
    const atLimit = stats.free.length;
    const groq = await waitFor(() => stats.free.slice(atLimit).some((r) => r.service === 'groq' && r.model === 'openai/gpt-oss-120b'), 30000, 300);
    check('when Mistral is rate limited, Groq takes over', groq, served(atLimit).join(','));

    const status = (await sessionState(control))?.engine;
    check('the engine reported no error', !status?.error, status?.error || '');
    check('no Claude request was made and no tokens are counted', stats.claude.length === 0 && status?.usage?.claudeTokens === 0, `${stats.claude.length} requests, ${status?.usage?.claudeTokens} tokens`);
    const shown = await meet.evaluate(() => document.getElementById('meet-tercuman-overlay')?.shadowRoot?.textContent || '');
    check('the page never names the service that translated', shown.length > 0 && !/deepl|mistral|groq/i.test(shown), shown.slice(0, 160));

    await send(control, { type: 'stop' });
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
    mock.close();
  }
}


// Real ElevenLabs (speech recognition and speech) through the extension, with Claude
// mocked unless an Anthropic key is in .env too.
async function realElevenLabsTest(keys) {
  console.log(`\n== Real ElevenLabs in the extension (${keys.an ? 'real Claude' : 'Claude mocked'}) ==`);
  const mock = await startMockApi({
    cert: readFileSync(path.join(fixtures, 'mock-cert.pem')),
    key: readFileSync(path.join(fixtures, 'mock-key.pem')),
    passthrough: keys.an ? ['api.elevenlabs.io', 'api.anthropic.com'] : ['api.elevenlabs.io'],
  });
  const env = await launch({ micWav: path.join(fixtures, 'turkish.wav'), remoteWav: path.join(fixtures, 'english.wav'), proxyPort: mock.port });
  const { control, meet, tabId } = env;
  const { stats } = mock;
  try {
    await control.evaluate(async (k) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), elevenLabsKey: k.el, anthropicKey: k.an || 'mock-an', claudeModel: 'claude-opus-5-5' } });
    }, keys);
    const startedAt = Date.now();
    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('a session with the real ElevenLabs key starts', start?.ok === true, start?.error);
    if (!start?.ok) return;

    const incoming = await waitFor(async () => done((await readCaptions(meet)).incoming), 30000, 300);
    check('real speech recognition hears the counterpart and the panel shows the translation', Boolean(incoming), JSON.stringify(incoming));
    console.log(`      first translated caption ${((Date.now() - startedAt) / 1000).toFixed(1)} s after start`);

    const outgoing = await waitFor(async () => done((await readCaptions(meet)).outgoing), 30000, 300);
    check('real speech recognition hears my Turkish', Boolean(outgoing), JSON.stringify(outgoing));
    const heard = await maxLevel(meet, 6000);
    check('real ElevenLabs speech reaches the far end', heard > 0.01, `level ${heard.toFixed(3)}`);

    await sleep(4000);
    if (!keys.an) {
      const english = stats.claude.map((c) => c.utterance).filter((u) => !/[çğışöü]/i.test(u));
      const sentences = (t) => (t.match(/[.!?](\s|$)/g) || []).length;
      console.log(`      utterances sent to translation: ${JSON.stringify(english.slice(0, 4))}`);
      check('long speech is translated sentence by sentence, not after the speaker stops', english.length >= 2 && english.some((u) => sentences(u) <= 2), `${english.length} pieces`);
    }
    const status = (await sessionState(control))?.engine;
    console.log(`      latency ${status?.latencyMs} ms, usage ${JSON.stringify(status?.usage)}`);
    check('latency is measured with the real services', status?.latencyMs != null, `${status?.latencyMs} ms`);
    check('the engine reported no error', !status?.error, status?.error || '');

    await mkdir(outDir, { recursive: true });
    const webm = Buffer.from(await meet.evaluate(() => window.__test.recording()), 'base64');
    await writeFile(path.join(outDir, 'far-end-real-elevenlabs.webm'), webm);
    console.log(`      far end audio saved to ${path.relative(root, path.join(outDir, 'far-end-real-elevenlabs.webm'))}`);
    await send(control, { type: 'stop' });
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
    mock.close();
  }
}

async function translationTest(keys) {
  console.log('\n== Translation round trip (uses the API keys in .env) ==');
  const env = await launch({ micWav: path.join(fixtures, 'turkish.wav'), remoteWav: path.join(fixtures, 'english.wav') });
  const { control, meet, tabId } = env;
  try {
    await control.evaluate(async (k) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(settings || {}), elevenLabsKey: k.el, anthropicKey: k.an, claudeModel: k.model } });
    }, { el: keys.el, an: keys.an, model: keys.model });

    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('a translation session starts', start?.ok === true, start?.error);
    if (!start?.ok) return;

    const readCaptions = () =>
      meet.evaluate(() => {
        const root = document.getElementById('meet-tercuman-overlay')?.shadowRoot;
        if (!root) return { incoming: [], outgoing: [] };
        const pick = (sel) => [...root.querySelectorAll(`${sel} .item`)].map((el) => ({
          translation: el.querySelector('.tr')?.textContent || '',
          source: el.querySelector('.src')?.textContent || '',
        }));
        return { incoming: pick('.incoming'), outgoing: pick('.outgoing') };
      });

    const incoming = await waitFor(async () => {
      const c = await readCaptions();
      return c.incoming.find((x) => x.translation && x.translation !== '…') ? c : null;
    }, 45000, 500);
    const captions = await readCaptions();
    check('the counterpart is transcribed and translated into Turkish', Boolean(incoming), JSON.stringify(captions.incoming.slice(-2)));

    const outgoing = await waitFor(async () => {
      const c = await readCaptions();
      return c.outgoing.find((x) => x.translation && x.translation !== '…') ? c : null;
    }, 45000, 500);
    check('my Turkish is transcribed and translated into English', Boolean(outgoing), JSON.stringify((await readCaptions()).outgoing.slice(-2)));

    const heard = await maxLevel(meet, 6000);
    check('the far end receives the translated English voice', heard > 0.02, `level ${heard.toFixed(3)}`);

    const status = (await sessionState(control))?.engine;
    console.log(`      latency ${status?.latencyMs} ms, usage ${JSON.stringify(status?.usage)}`);
    check('latency is measured', status?.latencyMs != null, `${status?.latencyMs} ms`);
    check('the engine reported no error', !status?.error, status?.error || '');

    await mkdir(outDir, { recursive: true });
    const webm = Buffer.from(await meet.evaluate(() => window.__test.recording()), 'base64');
    await writeFile(path.join(outDir, 'far-end-received.webm'), webm);
    console.log(`      far end audio saved to ${path.relative(root, path.join(outDir, 'far-end-received.webm'))}`);

    const toText = await send(control, { type: 'options', options: { incomingMode: 'text' } });
    check('switching to subtitles works mid-call', toText?.ok === true);
    await send(control, { type: 'stop' });
  } finally {
    await env.context.close();
    await rm(env.userDataDir, { recursive: true, force: true });
  }
}

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ is missing: run npm run build first');
  process.exit(1);
}
await mkdir(fixtures, { recursive: true });
makeFixtures();
await connectionTest();
await recordingTest();
await mockTranslationTest();
await freeTranslationTest();
const env = loadEnv();
// SKIP_REAL=1 runs only the keyless suites (no credits used).
if (env.ELEVENLABS_API_KEY && !process.env.SKIP_REAL) {
  await realElevenLabsTest({ el: env.ELEVENLABS_API_KEY, an: env.ANTHROPIC_API_KEY || '' });
} else {
  console.log('\n(Real ElevenLabs check skipped: put ELEVENLABS_API_KEY in .env to run it.)');
}
if (env.ELEVENLABS_API_KEY && env.ANTHROPIC_API_KEY && !process.env.SKIP_REAL) {
  await translationTest({ el: env.ELEVENLABS_API_KEY, an: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL || 'claude-opus-5-5' });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
