// Service worker: starts and stops sessions, owns the offscreen document, keeps the
// session state the popup shows, and passes settings to the engine (the offscreen
// document cannot read chrome.storage itself).

import { loadSettings, saveSettings, missingKeys } from '../shared/settings.js';
import { setLanguage, t, joinNames } from '../shared/i18n.js';

const OFFSCREEN_PATH = 'offscreen.html';
const MEET_PREFIX = 'https://meet.google.com/';
const IDLE = { status: 'idle', tabId: null, error: null, engine: null };

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return { ...IDLE, ...(state || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: next });
  await updateBadge(next);
  return next;
}

async function updateBadge(state) {
  setLanguage((await loadSettings()).uiLanguage);
  const badge = {
    running: { text: t('badge.on'), color: '#15803d' },
    starting: { text: '...', color: '#a16207' },
    error: { text: '!', color: '#b91c1c' },
  }[state.status] || { text: '', color: '#000000' };
  await chrome.action.setBadgeText({ text: badge.text });
  if (badge.text) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Captures the Meet tab audio and the microphone, and plays the live translation.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

function toEngine(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

let starting = null;

async function startSession({ tabId, streamId, options = {} }) {
  if (starting) await starting.catch(() => {});
  starting = (async () => {
    const tab = await chrome.tabs.get(tabId);
    const settings = await loadSettings();
    setLanguage(settings.uiLanguage);
    if (!tab.url?.startsWith(MEET_PREFIX)) throw new Error(t('err.notMeet'));

    if (options.mode !== 'diagnostic') {
      const missing = missingKeys(settings);
      if (missing.length) throw new Error(t('err.keysMissing', { names: joinNames(missing) }));
    }

    // The page hook is injected when Meet loads, so a tab opened before the extension
    // was installed (or reloaded) needs a refresh.
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'ping' }).catch(() => null);
    if (!ping?.hook) throw new Error(t('err.reloadMeet'));

    const current = await getState();
    if (current.status === 'running' || current.status === 'starting') await stopSession('restart');

    await setState({ status: 'starting', tabId, error: null, engine: null });
    if (!streamId) streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const response = await toEngine({ type: 'start', tabId, streamId, settings, options });
    if (!response?.ok) {
      await closeOffscreen();
      throw new Error(response?.error || t('err.engineFailed'));
    }
    await setState({ status: 'running', tabId, startedAt: Date.now(), mode: options.mode || 'translate', engine: response.status });
    await chrome.tabs.sendMessage(tabId, { type: 'connect-engine' }).catch(() => {});
    return response.status;
  })();
  try {
    return await starting;
  } catch (err) {
    await setState({ status: 'error', error: err.message, tabId: null });
    throw err;
  } finally {
    starting = null;
  }
}

// `error` goes to the Meet tab, whose panel then stays to say why the translation stopped.
async function stopSession(reason = 'user', error = null) {
  const state = await getState();
  if (await hasOffscreen()) await toEngine({ type: 'stop', reason }).catch(() => {});
  await closeOffscreen();
  if (state.tabId) chrome.tabs.sendMessage(state.tabId, { type: 'session-ended', error }).catch(() => {});
  if (reason === 'restart') return;
  if (state.status !== 'error' || reason === 'user') await setState({ ...IDLE });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  chrome.storage.session.set({ state: IDLE });
  updateBadge(IDLE);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.set({ state: IDLE });
  updateBadge(IDLE);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  const reply = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...(value && typeof value === 'object' ? value : {}) }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
    );
    return true;
  };

  switch (msg.type) {
    case 'start':
      return reply(startSession(msg).then((status) => ({ status })));
    case 'stop':
      return reply(stopSession('user'));
    case 'options':
      return reply(
        (async () => {
          if (msg.options?.incomingMode || msg.options?.outgoingMode) {
            const patch = {};
            if (msg.options.incomingMode) patch.incomingMode = msg.options.incomingMode;
            if (msg.options.outgoingMode) patch.outgoingMode = msg.options.outgoingMode;
            await saveSettings(patch);
          }
          if (await hasOffscreen()) return toEngine({ type: 'options', options: msg.options });
          return {};
        })(),
      );
    case 'chime':
      return reply(hasOffscreen().then((open) => (open ? toEngine({ type: 'chime' }) : {})));
    case 'tab-hello':
      return reply(getState().then((s) => ({ active: s.status === 'running' && s.tabId === sender.tab?.id })));
    case 'engine-status':
      getState().then((s) => {
        if (s.status === 'running') setState({ engine: msg.status });
      });
      return false;
    case 'recording-ready':
      chrome.tabs.create({ url: chrome.runtime.getURL(`recording.html?id=${encodeURIComponent(msg.id)}`) }).catch(() => {});
      return false;
    case 'engine-options':
      saveSettings(msg.options).catch(() => {});
      return false;
    case 'engine-failed':
      (async () => {
        await stopSession('error', msg.error);
        await setState({ status: 'error', error: msg.error, tabId: null, engine: null });
      })();
      return false;
    case 'call-ended':
      getState().then((s) => {
        if (s.status === 'running') stopSession('call-ended');
      });
      return false;
    default:
      return false;
  }
});

// Settings edited while a call is running reach the engine right away.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  if ((await getState()).status !== 'running' || !(await hasOffscreen())) return;
  toEngine({ type: 'settings', settings: await loadSettings() }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getState()).tabId === tabId) stopSession('tab-closed');
});

// Leaving Meet in the same tab ends the session, or the capture would go on listening to
// whatever plays there next. The extension may see the address of Meet pages only, so a
// tab whose address it cannot see has left Meet.
chrome.tabs.onUpdated.addListener(async (tabId, _info, tab) => {
  const state = await getState();
  if (state.tabId !== tabId || state.status !== 'running') return;
  if (!tab.url?.startsWith(MEET_PREFIX)) stopSession('left-meet');
});

// Keyboard shortcut: also counts as invoking the extension, which tab capture needs.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translation') return;
  const state = await getState();
  if (state.status === 'running' || state.status === 'starting') {
    await stopSession('user');
    return;
  }
  if (!tab?.id) return;
  startSession({ tabId: tab.id, options: {} }).catch((err) => console.warn('[tercuman]', err.message));
});
