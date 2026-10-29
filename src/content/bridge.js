// Content script on meet.google.com (extension world). It connects the page hook
// (Meet's world) with the engine (offscreen document) and shows the panel and the
// subtitle bar.
//
//   page hook <-MessagePort-> this script <-runtime port-> engine

import { Overlay } from './overlay.js';
import { SubtitleBar } from './subtitle-bar.js';
import { setLanguage } from '../shared/i18n.js';

const state = {
  pagePort: null,
  hookReady: false,
  enginePort: null,
  overlay: null,
  subtitles: null,
  hello: null,
  last: {}, // latest status, clone and modes, replayed when the panel is rebuilt
};

// ---- page hook handshake --------------------------------------------------------------

const offered = [];

function offerPort() {
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => onPageMessage(channel.port1, event.data);
  offered.push(channel.port1);
  window.postMessage({ __meetTercuman: 'port' }, '*', [channel.port2]);
}

function onPageMessage(port, msg) {
  if (msg?.type === 'hello') {
    if (state.pagePort && state.pagePort !== port) return;
    state.pagePort = port;
    state.hookReady = true;
    for (const other of offered.splice(0)) if (other !== port) other.close();
    if (state.enginePort) port.postMessage({ type: 'probe' });
    return;
  }
  if (port !== state.pagePort) return;
  if (msg?.type === 'page-state') state.enginePort?.postMessage(msg);
}

document.addEventListener('meet-tercuman-hook-ready', () => {
  if (!state.pagePort) offerPort();
});
offerPort();

// ---- engine connection ----------------------------------------------------------------

function connectEngine() {
  if (state.enginePort) return;
  const port = chrome.runtime.connect({ name: 'meet-tab' });
  state.enginePort = port;
  port.onMessage.addListener(onEngineMessage);
  port.onDisconnect.addListener(() => {
    if (state.enginePort !== port) return;
    state.enginePort = null;
    state.pagePort?.postMessage({ type: 'deactivate', final: true });
    state.overlay?.setDisconnected();
    hideSubtitles();
  });
  state.pagePort?.postMessage({ type: 'probe' });
}

function endSession() {
  state.pagePort?.postMessage({ type: 'deactivate', final: true });
  const port = state.enginePort;
  state.enginePort = null;
  try {
    port?.disconnect();
  } catch {
    // already closed
  }
  state.overlay?.destroy();
  state.overlay = null;
  hideSubtitles();
}

function showSubtitles() {
  if (state.subtitles || !state.hello?.subtitleBar) return;
  const mount = () => {
    if (state.subtitles || !state.hello?.subtitleBar) return;
    state.subtitles = new SubtitleBar();
    state.subtitles.setEnabled(state.hello.incomingMode !== 'off');
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

function hideSubtitles() {
  state.subtitles?.destroy();
  state.subtitles = null;
}

function showOverlay() {
  if (state.overlay || !state.hello || state.hello.showOverlay === false) return;
  const mount = () => {
    state.overlay = new Overlay({
      hello: state.hello,
      onOptions: (options) => state.enginePort?.postMessage({ type: 'ui', action: 'options', options }),
      onChime: () => state.enginePort?.postMessage({ type: 'ui', action: 'chime' }),
      onStop: () => chrome.runtime.sendMessage({ type: 'stop' }).catch(() => endSession()),
    });
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

// A new interface language rebuilds the panel with the latest state.
function rebuildOverlay() {
  state.overlay?.destroy();
  state.overlay = null;
  showOverlay();
  if (!state.overlay) return;
  if (state.last.modes) state.overlay.modes(state.last.modes);
  if (state.last.clone) state.overlay.clone(state.last.clone);
  if (state.last.status) state.overlay.status(state.last.status);
}

// Testing on this computer: `localStorage['meet-tercuman-debug'] = '<port>'` on the Meet
// page makes the engine copy its audio and transcripts to http://127.0.0.1:<port>.
function askForDebugCopies() {
  let port = null;
  try {
    port = localStorage.getItem('meet-tercuman-debug');
  } catch {
    // storage blocked
  }
  if (port) state.enginePort?.postMessage({ type: 'debug-sink', port });
}

function onEngineMessage(msg) {
  switch (msg?.type) {
    case 'hello':
      state.hello = msg;
      setLanguage(msg.uiLanguage);
      showOverlay();
      showSubtitles();
      askForDebugCopies();
      break;
    case 'language':
      setLanguage(msg.uiLanguage);
      if (state.hello) state.hello = { ...state.hello, uiLanguage: msg.uiLanguage };
      rebuildOverlay();
      break;
    case 'activate':
    case 'deactivate':
    case 'tts':
      state.pagePort?.postMessage(msg);
      break;
    case 'caption':
      state.overlay?.caption(msg);
      state.subtitles?.caption(msg);
      break;
    case 'status':
      state.last.status = msg.status;
      state.overlay?.status(msg.status);
      break;
    case 'clone':
      state.last.clone = msg.clone;
      state.overlay?.clone(msg.clone);
      break;
    case 'modes':
      state.last.modes = msg;
      if (state.hello) {
        const { type: _type, ...modes } = msg;
        state.hello = { ...state.hello, ...modes };
      }
      state.overlay?.modes(msg);
      if (msg.incomingMode) state.subtitles?.setEnabled(msg.incomingMode !== 'off');
      break;
    case 'subtitles':
      if (state.hello) state.hello.subtitleBar = msg.show;
      if (msg.show) showSubtitles();
      else hideSubtitles();
      break;
    case 'overlay':
      if (state.hello) state.hello.showOverlay = msg.show;
      if (msg.show) showOverlay();
      else {
        state.overlay?.destroy();
        state.overlay = null;
      }
      break;
    default:
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'ping':
      sendResponse({ hook: state.hookReady });
      return false;
    case 'connect-engine':
      connectEngine();
      sendResponse({ ok: true });
      return false;
    case 'session-ended':
      endSession();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

// After a reload during a running session, rejoin it.
chrome.runtime
  .sendMessage({ type: 'tab-hello' })
  .then((reply) => {
    if (reply?.active) connectEngine();
  })
  .catch(() => {});
