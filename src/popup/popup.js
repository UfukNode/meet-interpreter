import { loadSettings, saveSettings, missingKeys, isFreeTranslation } from '../shared/settings.js';
import { localPairs, localTranslationState, prepareLocalTranslation } from '../shared/local-translation.js';
import { formatUsage } from '../shared/usage.js';
import { setLanguage, t, applyI18n, languageLabel, joinNames, locale } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);

const HINT_KEYS = { incoming: 'popup.hint.in', outgoing: 'popup.hint.out' };

let settings;
let tab;
let state;

function setSeg(id, value) {
  for (const button of $(id).querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === value));
  }
  const key = id === 'incoming' ? 'inHint' : 'outHint';
  $(key).textContent = t(`${HINT_KEYS[id]}.${value}`);
}

function notice(text, { bad = false, action } = {}) {
  const box = $('notice');
  box.hidden = !text;
  box.className = `notice${bad ? ' bad' : ''}`;
  box.replaceChildren();
  if (!text) return;
  box.append(document.createTextNode(text));
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    box.append(document.createElement('br'), button);
  }
}

const isMeet = () => Boolean(tab?.url?.startsWith('https://meet.google.com/'));

function render() {
  const running = state.status === 'running' && state.tabId === tab?.id;
  const busy = state.status === 'starting';
  const elsewhere = state.status === 'running' && state.tabId !== tab?.id;
  const engine = running ? state.engine : null;
  const diagnostic = running && state.mode === 'diagnostic';

  const missing = missingKeys(settings);
  if (state.status === 'error' && state.error) notice(state.error, { bad: true });
  else if (!isMeet()) notice(t('popup.openMeet'));
  else if (missing.length && !running)
    notice(t('popup.keysMissing', { names: joinNames(missing) }), {
      action: { label: t('popup.openSettings'), run: () => chrome.runtime.openOptionsPage() },
    });
  else if (elsewhere) notice(t('popup.elsewhere'));
  else notice('');

  $('consentRow').hidden = !settings.offerTheirClone || settings.incomingMode !== 'voice';
  // A recording has to be chosen before the start: the tab picture is captured then.
  $('recordRow').hidden = running || busy;

  const primary = $('primary');
  primary.disabled = busy || !isMeet() || (!running && missing.length > 0);
  primary.textContent = busy ? t('popup.starting') : running ? (diagnostic ? t('popup.endTest') : t('popup.stop')) : t('popup.start');
  primary.classList.toggle('stop', running);
  $('test').hidden = running;
  $('test').disabled = busy || !isMeet();
  $('chime').hidden = !running;

  $('live').hidden = !running;
  if (engine) {
    const stt = Object.values(engine.stt || {}).filter((s) => s !== 'off');
    let text = t('popup.state.listening');
    if (diagnostic) text = engine.page?.connected ? t('popup.state.testOn') : t('popup.state.connecting');
    else if (stt.some((s) => s === 'connecting' || s === 'reconnecting')) text = t('popup.state.connecting');
    else if (engine.outgoingMode === 'voice' && engine.page?.muted) text = t('popup.state.mutedMeet');
    $('liveState').textContent = text;
    $('liveLatency').textContent =
      engine.latencyMs != null
        ? t('common.seconds', { n: (engine.latencyMs / 1000).toLocaleString(locale(), { maximumFractionDigits: 1 }) })
        : '-';
    $('liveUsage').textContent = diagnostic ? '-' : formatUsage(engine.usage);
  }
}

// Free translation lands on Chrome's own translator, whose language packs can only be
// downloaded right after a click: the Start click is that moment.
async function prepareFreeTranslation() {
  const pairs = localPairs(settings);
  if ((await localTranslationState(pairs)) !== 'download') return;
  notice(t('popup.preparingFree'));
  await Promise.race([prepareLocalTranslation(pairs), new Promise((resolve) => setTimeout(resolve, 30000))]);
  notice('');
}

async function start(mode) {
  try {
    notice('');
    if (mode !== 'diagnostic' && isFreeTranslation(settings)) await prepareFreeTranslation();
    // The stream id expires within seconds, so it is fetched last.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const options =
      mode === 'diagnostic'
        ? { mode }
        : { incomingMode: settings.incomingMode, outgoingMode: settings.outgoingMode, cloneConsent: $('consent').checked, record: $('record').checked };
    state = { ...state, status: 'starting' };
    render();
    const reply = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, streamId, options });
    if (!reply?.ok) throw new Error(reply?.error || t('popup.startFailed'));
  } catch (err) {
    state = { ...state, status: 'error', error: err.message };
    render();
  }
}

// Static texts, the language pair labels and the mode hints, in the chosen language.
function applyLanguage(code) {
  setLanguage(code);
  applyI18n();
  for (const button of $('uiLanguage').querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === code));
  }
  const mine = languageLabel(settings.myLanguage);
  const theirs = languageLabel(settings.theirLanguage);
  $('pair').textContent = `${theirs} ↔ ${mine}`;
  $('inLabel').textContent = t('popup.inLabel', { from: theirs, to: mine });
  $('outLabel').textContent = t('popup.outLabel', { from: mine, to: theirs });
  setSeg('incoming', settings.incomingMode);
  setSeg('outgoing', settings.outgoingMode);
}

async function changeMode(kind, value) {
  settings = await saveSettings({ [kind]: value });
  setSeg(kind === 'incomingMode' ? 'incoming' : 'outgoing', value);
  if (state.status === 'running') chrome.runtime.sendMessage({ type: 'options', options: { [kind]: value } }).catch(() => {});
  render();
}

async function init() {
  const [loaded, tabs, session] = await Promise.all([
    loadSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.session.get('state'),
  ]);
  settings = loaded;
  tab = tabs[0];
  state = session.state || { status: 'idle' };

  applyLanguage(settings.uiLanguage);
  $('consent').checked = Boolean(state.status === 'running' && state.engine?.cloneConsent);
  for (const button of $('uiLanguage').querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      settings = await saveSettings({ uiLanguage: button.dataset.value });
      applyLanguage(settings.uiLanguage);
      render();
    });
  }
  for (const button of $('incoming').querySelectorAll('button')) {
    button.addEventListener('click', () => changeMode('incomingMode', button.dataset.value));
  }
  for (const button of $('outgoing').querySelectorAll('button')) {
    button.addEventListener('click', () => changeMode('outgoingMode', button.dataset.value));
  }
  $('consent').addEventListener('change', () => {
    if (state.status === 'running') {
      chrome.runtime.sendMessage({ type: 'options', options: { cloneConsent: $('consent').checked } }).catch(() => {});
    }
  });
  $('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('primary').addEventListener('click', async () => {
    if (state.status === 'running' && state.tabId === tab.id) {
      await chrome.runtime.sendMessage({ type: 'stop' }).catch(() => {});
    } else {
      await start('translate');
    }
  });
  $('test').addEventListener('click', () => start('diagnostic'));
  $('chime').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'chime' }).catch(() => {}));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.state) {
      state = changes.state.newValue || { status: 'idle' };
      render();
    }
    if (area === 'local' && changes.settings) {
      const language = settings.uiLanguage;
      settings = { ...settings, ...changes.settings.newValue };
      if (settings.uiLanguage !== language) applyLanguage(settings.uiLanguage);
      render();
    }
  });
  render();
}

init();
