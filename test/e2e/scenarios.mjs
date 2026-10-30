// What happens around the translation itself, against the mock Meet call and the local
// mock APIs (no keys, no cost):
//
//   node test/e2e/scenarios.mjs        (npm run test:scenarios builds first)
//
// Restarts, a page reload, mode switches, a dropped connection, services failing
// mid-call, settings changed mid-call, the panel, leaving the call, closing the tab,
// and cloning the other person's voice.

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { dist, fixtures, check, sleep, makeFixtures, launch, send, sessionState, maxLevel, waitFor, startMock, closeBrowser, summary } from './harness.mjs';

const THANKS = 'Merhaba, bugün görüşmeye katıldığınız için teşekkürler.';

const setSettings = (control, patch) =>
  control.evaluate(async (p) => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(settings || {}), ...p } });
  }, patch);

// Speech recognition connections still open, by language.
const openSockets = (stats, language) => stats.stt.filter((s) => s.open && (!language || s.language === language)).length;

// The panel as the person sees it.
const panel = (meet) =>
  meet.evaluate(() => {
    const hosts = document.querySelectorAll('#meet-tercuman-overlay');
    const root = hosts[0]?.shadowRoot;
    const el = root?.querySelector('.panel');
    if (!el) return { count: hosts.length };
    const box = el.getBoundingClientRect();
    const alert = root.querySelector('.alert');
    return {
      count: hosts.length,
      small: el.classList.contains('min'),
      text: root.textContent,
      headline: root.querySelector('.headline')?.textContent,
      labels: [...root.querySelectorAll('.label')].map((x) => x.textContent),
      notes: [...root.querySelectorAll('.note')].map((x) => x.textContent),
      errors: [...root.querySelectorAll('.item.error')].map((x) => x.textContent),
      mark: alert && !alert.hidden ? (alert.classList.contains('bad') ? 'bad' : 'warn') : '',
      left: Math.round(box.left),
      bottom: Math.round(innerHeight - box.bottom),
    };
  });

const subtitleText = (meet) => meet.evaluate(() => document.getElementById('meet-tercuman-subtitles')?.shadowRoot?.textContent ?? null);

// Translations asked for: what they said (English) and what I said (Turkish).
const asked = (stats, dir) => stats.claude.filter((c) => (dir === 'in' ? /thanks/i : /cuma/i).test(c.utterance)).length;

async function openCall(mock) {
  const env = await launch({ micWav: path.join(fixtures, 'turkish.wav'), remoteWav: path.join(fixtures, 'english.wav'), proxyPort: mock.port });
  await setSettings(env.control, { elevenLabsKey: 'mock-el', anthropicKey: 'mock-an', claudeModel: 'claude-opus-5-5', uiLanguage: 'en', myVoiceId: '' });
  return env;
}

async function callScenarios() {
  console.log('\n== One call, start to finish: restarts, reload, modes, failures, settings ==');
  const mock = await startMock();
  const { stats, faults } = mock;
  const env = await openCall(mock);
  const { control, meet, tabId } = env;
  try {
    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('a translation session starts', start?.ok === true, start?.error);
    if (!start?.ok) return;
    const sockets = await waitFor(() => openSockets(stats, 'en') === 1 && openSockets(stats, 'tr') === 1, 10000);
    check('one speech recognition connection per direction', sockets, `en ${openSockets(stats, 'en')}, tr ${openSockets(stats, 'tr')}`);
    const first = await waitFor(async () => (await subtitleText(meet))?.includes(THANKS), 30000, 300);
    check('their words arrive as subtitles', first);

    // No voice of my own is set: a warning, which marks the small button but does not open it.
    const warned = await waitFor(async () => (await panel(meet)).mark === 'warn', 4000);
    check('a warning marks the small button and leaves it small', warned && (await panel(meet)).small === true, JSON.stringify(await panel(meet)));
    await setSettings(control, { myVoiceId: 'mock-voice-b' });
    const cleared = await waitFor(async () => (await panel(meet)).mark === '', 4000);
    check('choosing my voice mid-call clears the warning', cleared);
    const ttsAt = stats.tts.length;
    const mine = await waitFor(() => stats.tts.slice(ttsAt).find((x) => x.language_code === 'en'), 30000, 300);
    check('my next sentence is spoken in the voice chosen mid-call', mine?.voice === 'mock-voice-b', mine?.voice);

    // Start again while running: one panel, the old connections closed.
    const again = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('starting again while running works', again?.ok === true, again?.error);
    await waitFor(() => openSockets(stats, 'en') === 1 && openSockets(stats, 'tr') === 1, 10000);
    await sleep(1500);
    check('after a restart there is one panel and one connection per direction', (await panel(meet)).count === 1 && openSockets(stats) === 2, `panels ${(await panel(meet)).count}, sockets ${openSockets(stats)}`);

    // Modes: off closes the connection (nothing billed), quick switching leaves none behind.
    await send(control, { type: 'options', options: { incomingMode: 'off' } });
    const inClosed = await waitFor(() => openSockets(stats, 'en') === 0, 4000);
    check('turning their side off closes its speech recognition', inClosed, `open ${openSockets(stats, 'en')}`);
    for (const mode of ['voice', 'off', 'voice', 'off', 'voice']) {
      await send(control, { type: 'options', options: { incomingMode: mode } });
      await sleep(60);
    }
    await sleep(4000);
    check('switching back and forth quickly leaves one connection, not several', openSockets(stats, 'en') === 1, `open ${openSockets(stats, 'en')}`);
    await send(control, { type: 'options', options: { incomingMode: 'off', outgoingMode: 'off' } });
    const none = await waitFor(() => openSockets(stats) === 0, 4000);
    check('with both directions off nothing is listening', none, `open ${openSockets(stats)}`);
    const real = await maxLevel(meet, 2500);
    check('with my side off they hear my real voice', real > 0.01, `level ${real.toFixed(3)}`);
    await send(control, { type: 'options', options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    const back = await waitFor(() => openSockets(stats, 'en') === 1 && openSockets(stats, 'tr') === 1, 10000);
    check('turning both back on reconnects both', back, `en ${openSockets(stats, 'en')}, tr ${openSockets(stats, 'tr')}`);

    // A dropped connection reconnects by itself and the words keep coming.
    const sessionsBefore = stats.stt.length;
    const askedBefore = asked(stats, 'in');
    mock.dropStt();
    const reconnected = await waitFor(() => stats.stt.length >= sessionsBefore + 2 && openSockets(stats) === 2, 15000);
    check('after a dropped connection both directions reconnect', reconnected, `sessions ${sessionsBefore} -> ${stats.stt.length}, open ${openSockets(stats)}`);
    const flowing = await waitFor(() => asked(stats, 'in') > askedBefore, 30000, 300);
    check('their words keep being translated after the drop', flowing);

    // Speech fails: the translation stays readable with a note under it.
    faults.tts = 401;
    const noted = await waitFor(async () => (await panel(meet)).notes.some((n) => /could not be spoken/i.test(n)), 30000, 300);
    check('when speech fails the subtitle stays, with a note', noted, JSON.stringify((await panel(meet)).notes));
    faults.tts = 0;

    // Translation fails: an error line, and the call goes on.
    faults.claude = 529;
    const failed = await waitFor(async () => (await panel(meet)).errors.length > 0, 40000, 300);
    check('when Claude is overloaded the line says so', failed, JSON.stringify((await panel(meet)).errors));
    check('the error does not claim it will retry', !(await panel(meet)).errors.some((e) => /retry/i.test(e)), JSON.stringify((await panel(meet)).errors));
    faults.claude = 0;
    const askedAfterFault = asked(stats, 'in');
    const recovered = await waitFor(async () => asked(stats, 'in') > askedAfterFault && (await sessionState(control))?.status === 'running', 30000, 300);
    check('translation goes on once Claude answers again', recovered);

    // Settings changed mid-call.
    await setSettings(control, { uiLanguage: 'tr' });
    const turkish = await waitFor(async () => (await panel(meet)).headline === 'Meet Tercüman', 4000);
    check('the panel switches to Turkish mid-call', turkish, (await panel(meet)).headline);
    await setSettings(control, { uiLanguage: 'en' });
    await waitFor(async () => (await panel(meet)).headline === 'Meet Interpreter', 4000);

    await setSettings(control, { theirLanguage: 'de' });
    const german = await waitFor(() => openSockets(stats, 'de') === 1 && openSockets(stats, 'en') === 0, 10000);
    check('changing their language mid-call listens in the new language', german, `de ${openSockets(stats, 'de')}, en ${openSockets(stats, 'en')}`);
    const label = await waitFor(async () => (await panel(meet)).labels.some((l) => /German/.test(l)), 4000);
    check('the panel names the new language', label, JSON.stringify((await panel(meet)).labels));
    const deAt = stats.claude.length;
    const toTurkish = await waitFor(() => stats.claude.slice(deAt).some((c) => /German to Turkish/.test(c.pair || '')), 30000, 300);
    check('their words are now translated from German', toTurkish, JSON.stringify(stats.claude.slice(deAt).map((c) => c.pair)));
    await setSettings(control, { theirLanguage: 'en' });
    await waitFor(() => openSockets(stats, 'en') === 1, 10000);

    await setSettings(control, { subtitleBar: false });
    const hidden = await waitFor(async () => (await subtitleText(meet)) === null, 4000);
    check('turning the subtitle bar off mid-call removes it', hidden);
    await setSettings(control, { subtitleBar: true });
    const shown = await waitFor(async () => (await subtitleText(meet))?.includes(THANKS), 30000, 300);
    check('turning it back on brings the subtitles back', shown);

    // The panel goes where it is dragged and stays there after a reload.
    const before = await panel(meet);
    const handle = meet.locator('#meet-tercuman-overlay .headline');
    const box = await handle.boundingBox();
    await meet.mouse.move(box.x + 10, box.y + 8);
    await meet.mouse.down();
    await meet.mouse.move(box.x + 160, box.y - 60, { steps: 8 });
    await meet.mouse.up();
    const dragged = await panel(meet);
    check('the panel can be dragged', Math.abs(dragged.left - before.left - 150) <= 3 && Math.abs(dragged.bottom - before.bottom - 68) <= 3, `${JSON.stringify(before)} -> ${dragged.left},${dragged.bottom}`);
    check('a drag does not open it', dragged.small === true);

    await meet.reload();
    await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
    const rejoined = await waitFor(async () => (await panel(meet)).count === 1, 10000);
    check('after a page reload the panel comes back by itself', rejoined);
    const where = await panel(meet);
    check('the panel keeps its place after a reload', Math.abs(where.left - dragged.left) <= 3 && Math.abs(where.bottom - dragged.bottom) <= 3, `${where.left},${where.bottom}`);
    const askedAtReload = asked(stats, 'in');
    const afterReload = await waitFor(() => asked(stats, 'in') > askedAtReload, 30000, 300);
    check('translation goes on after the reload', afterReload);
    const swapped = await waitFor(async () => (await sessionState(control))?.engine?.page?.senders > 0, 8000);
    check('my translated voice is attached to the call again', Boolean(swapped));

    // Speech recognition ends for good (quota used up): the page says why.
    faults.stt = 'quota_exceeded';
    const stopped = await waitFor(async () => (await sessionState(control))?.status === 'error', 15000, 300);
    const state = await sessionState(control);
    check('a fatal speech recognition error ends the session', stopped, JSON.stringify(state?.error));
    await sleep(1500);
    const after = await panel(meet);
    check('the panel stays to say why it stopped', after.count === 1 && /quota/i.test(after.text || '') && after.small === false, JSON.stringify({ count: after.count, small: after.small, text: after.text?.slice(0, 160) }));
    const freed = await maxLevel(meet, 2500);
    check('after the stop they hear my real voice again', freed > 0.01, `level ${freed.toFixed(3)}`);
    check('no connection is left open', openSockets(stats) === 0, `open ${openSockets(stats)}`);
    if (after.count) {
      await meet.locator('#meet-tercuman-overlay .icon.stop').click();
      check('the stopped panel can be closed', await waitFor(async () => (await panel(meet)).count === 0, 3000));
    }
    faults.stt = null;
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await closeBrowser(env);
    mock.close();
  }
}

async function leavingScenarios() {
  console.log('\n== Leaving the call, leaving Meet, closing the tab ==');
  const mock = await startMock();
  const { stats } = mock;
  const env = await openCall(mock);
  const { control, worker, context } = env;
  let { meet, tabId } = env;
  const offscreenOpen = () => worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0);
  try {
    let start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('a translation session starts', start?.ok === true, start?.error);
    await waitFor(() => openSockets(stats) === 2, 10000);
    await meet.evaluate(() => window.__test.leave());
    const ended = await waitFor(async () => (await sessionState(control))?.status === 'idle', 40000, 500);
    check('leaving the call ends the translation by itself', ended, (await sessionState(control))?.status);
    check('nothing is left listening after leaving', openSockets(stats) === 0 && !(await offscreenOpen()), `open ${openSockets(stats)}`);
    check('the panel is gone after leaving', (await panel(meet)).count === 0);

    await meet.reload();
    await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
    start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('it starts again after rejoining', start?.ok === true, start?.error);
    await waitFor(() => openSockets(stats) === 2, 10000);
    await meet.goto('about:blank');
    const left = await waitFor(async () => (await sessionState(control))?.status === 'idle' && !(await offscreenOpen()), 8000);
    check('going to another page ends the translation', left && openSockets(stats) === 0, `open ${openSockets(stats)}`);

    meet = await context.newPage();
    await meet.goto('https://meet.google.com/abc-defg-hij');
    await meet.waitForFunction(() => window.__test, null, { timeout: 15000 });
    await meet.bringToFront();
    tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://meet.google.com/*' }))[0].id);
    start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice' } });
    check('it starts in a new Meet tab', start?.ok === true, start?.error);
    await waitFor(() => openSockets(stats) === 2, 10000);
    await meet.close();
    const closed = await waitFor(async () => (await sessionState(control))?.status === 'idle' && !(await offscreenOpen()), 8000);
    check('closing the Meet tab ends the translation', closed && openSockets(stats) === 0, `open ${openSockets(stats)}`);
  } finally {
    await closeBrowser(env);
    mock.close();
  }
}

async function cloneScenario() {
  console.log("\n== Cloning the other person's voice, with consent ==");
  const mock = await startMock();
  const { stats } = mock;
  const env = await openCall(mock);
  const { control, tabId } = env;
  try {
    // A short sample so the test does not wait the usual 45 seconds.
    await setSettings(control, { offerTheirClone: true, cloneSeconds: 3, deleteCloneAfter: true, myVoiceId: 'mock-voice-a' });
    const start = await send(control, { type: 'start', tabId, options: { incomingMode: 'voice', outgoingMode: 'voice', cloneConsent: true } });
    check('a session with clone consent starts', start?.ok === true, start?.error);
    const ready = await waitFor(async () => (await sessionState(control))?.engine?.clone?.state === 'ready', 30000, 300);
    check('their voice is cloned from the call', ready, JSON.stringify((await sessionState(control))?.engine?.clone));
    const at = stats.tts.length;
    const spoken = await waitFor(() => stats.tts.slice(at).find((x) => x.language_code === 'tr'), 30000, 300);
    check('their translation is then spoken in the cloned voice', spoken?.voice === 'mock-clone', spoken?.voice);
    await send(control, { type: 'stop' });
    const deleted = await waitFor(() => stats.requests.includes('DELETE api.elevenlabs.io/v1/voices/mock-clone'), 8000);
    check('the clone is deleted when the call ends', deleted);
    check('no script errors on the Meet page', env.pageErrors.length === 0, env.pageErrors.join(' | '));
  } finally {
    await closeBrowser(env);
    mock.close();
  }
}

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ is missing: run npm run build first');
  process.exit(1);
}
await mkdir(fixtures, { recursive: true });
makeFixtures();
await callScenarios();
await leavingScenarios();
await cloneScenario();
process.exit(summary());
