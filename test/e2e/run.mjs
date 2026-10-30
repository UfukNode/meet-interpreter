// End-to-end test: loads dist/ into Chromium, serves a mock Meet call at
// https://meet.google.com/ and drives the real extension.
//
//   node test/e2e/run.mjs           connection test (no API keys needed)
//   with keys in .env               also a full translation round trip
//
// The fake microphone plays a WAV file and the mock call plays another one as the
// counterpart. Test audio is made with macOS `say` and ffmpeg the first time.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startMockApi } from './mock-api.mjs';
import {
  root, dist, fixtures, outDir, check, sleep, loadEnv, makeFixtures, launch, send, sessionState, maxLevel, waitFor, readCaptions, done, summary,
} from './harness.mjs';

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
    // A script in Meet's page cannot tick the consent box or ask for debug copies.
    const scripted = await meet.evaluate(async () => {
      localStorage.setItem('meet-tercuman-debug', '47913');
      const row = document.getElementById('meet-tercuman-overlay')?.shadowRoot?.querySelector('.clone');
      const box = row?.querySelector('input');
      box?.click();
      row?.click();
      row?.querySelector('span')?.click();
      await new Promise((r) => setTimeout(r, 800));
      localStorage.removeItem('meet-tercuman-debug');
      return { found: Boolean(box), checked: box?.checked };
    });
    // The same, when the page first stops the click from reaching the panel's own listeners.
    const afterScript = (await sessionState(control))?.engine;
    check('a page script cannot give clone consent', scripted.found && scripted.checked === false && afterScript?.cloneConsent === false, JSON.stringify(scripted));
    for (const target of ['input', 'label']) {
      const shown = await meet.evaluate(async (which) => {
        const stop = (event) => event.stopPropagation();
        document.addEventListener('click', stop, true);
        const row = document.getElementById('meet-tercuman-overlay')?.shadowRoot?.querySelector('.clone');
        (which === 'input' ? row?.querySelector('input') : row)?.click();
        document.removeEventListener('click', stop, true);
        await new Promise((r) => setTimeout(r, 2500));
        return row?.querySelector('input')?.checked;
      }, target);
      const engine = (await sessionState(control))?.engine;
      check(`nor when it stops a click on the ${target} before the panel sees it`, engine?.cloneConsent === false && shown === false, `shown ${shown}, engine ${engine?.cloneConsent}`);
    }
    // The panel starts as a small button and opens with your own click.
    const panelState = () =>
      meet.evaluate(() => {
        const panel = document.getElementById('meet-tercuman-overlay')?.shadowRoot?.querySelector('.panel');
        return { small: panel?.classList.contains('min'), width: Math.round(panel?.getBoundingClientRect().width || 0) };
      });
    const first = await panelState();
    check('the panel starts as a small button', first.small === true && first.width > 0 && first.width < 260, JSON.stringify(first));
    await meet.locator('#meet-tercuman-overlay .headline').click();
    const opened = await waitFor(async () => (await panelState()).small === false, 2000, 100);
    check('a click on the button opens the panel', Boolean(opened), JSON.stringify(await panelState()));
    // A real click (trusted input from the browser) still gives and withdraws consent.
    await meet.locator('#meet-tercuman-overlay .clone input').click();
    const granted = await waitFor(async () => (await sessionState(control))?.engine?.cloneConsent === true, 3000, 200);
    await meet.locator('#meet-tercuman-overlay .clone input').click();
    const withdrawn = await waitFor(async () => (await sessionState(control))?.engine?.cloneConsent === false, 3000, 200);
    check('your own click on the box still gives and withdraws consent', Boolean(granted) && Boolean(withdrawn), `${granted} / ${withdrawn}`);
    await meet.locator('#meet-tercuman-overlay .icon:not(.open):not(.stop)').click();
    const closed = await waitFor(async () => (await panelState()).small === true, 2000, 100);
    check('the minimize button makes it small again', Boolean(closed));
    check('a normal build ignores a page request for debug copies', afterScript?.debugCopies === false, String(afterScript?.debugCopies));
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
process.exit(summary());
