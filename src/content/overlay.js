import { t, languageLabel } from '../shared/i18n.js';
import { formatUsage, formatNumber as num } from '../shared/usage.js';

// The floating panel on the Meet page: live subtitles in both directions, the
// translation mode switches, the voice clone consent and a usage counter. It lives
// in a shadow root and is built with DOM calls only (Meet enforces Trusted Types).

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel {
  position: fixed; left: 16px; bottom: 96px; z-index: 2147483000;
  width: 380px; max-width: calc(100vw - 32px);
  font: 13px/1.4 "Google Sans", Roboto, system-ui, sans-serif; color: #e8eaed;
  background: rgba(24, 26, 31, 0.94); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 14px; box-shadow: 0 10px 32px rgba(0,0,0,0.45);
  backdrop-filter: blur(8px); overflow: hidden; user-select: none;
}
.header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: grab; background: rgba(255,255,255,0.04); }
.header:active { cursor: grabbing; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #9aa0a6; flex: none; }
.dot.ok { background: #34a853; } .dot.wait { background: #fbbc04; } .dot.bad { background: #ea4335; }
.headline { font-weight: 600; }
.rec { color: #fff; background: #d93025; border-radius: 6px; padding: 1px 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; }
.rec.debug { background: #f29900; color: #202124; }
.meta { flex: 1; color: #9aa0a6; font-size: 12px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon { all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 6px; text-align: center; line-height: 24px; color: #bdc1c6; font-size: 14px; }
.icon:hover { background: rgba(255,255,255,0.1); color: #fff; }
.icon.stop:hover { background: rgba(234,67,53,0.25); color: #fff; }
.body { padding: 4px 12px 6px; max-height: 46vh; overflow: auto; }
.panel.min .body, .panel.min .bottom { display: none; }
.bottom { padding: 0 12px 10px; }
section { padding: 8px 0; border-top: 1px solid rgba(255,255,255,0.07); }
section:first-child { border-top: 0; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.label { color: #bdc1c6; font-size: 12px; font-weight: 600; }
.seg { display: inline-flex; background: rgba(255,255,255,0.07); border-radius: 8px; padding: 2px; }
.seg-btn { all: unset; cursor: pointer; padding: 3px 9px; border-radius: 6px; font-size: 12px; color: #bdc1c6; }
.seg-btn.on { background: #8ab4f8; color: #202124; font-weight: 600; }
.seg-btn:focus-visible, .btn:focus-visible, .icon:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
.list { display: flex; flex-direction: column; gap: 6px; }
.item .tr { font-size: 16px; line-height: 1.35; color: #fff; user-select: text; }
.panel.text-mode .incoming .item .tr { font-size: 19px; }
.item .src { font-size: 12px; color: #9aa0a6; margin-top: 1px; user-select: text; }
.item.pending .tr { color: #9aa0a6; }
.item.error .tr { color: #f28b82; font-size: 13px; }
.item .note { font-size: 12px; color: #f28b82; margin-top: 2px; }
.outgoing .item .tr { font-size: 14px; color: #c6dafc; }
.live { font-size: 12px; color: #9aa0a6; font-style: italic; margin-top: 4px; }
.empty { font-size: 12px; color: #80868b; }
.notice { margin: 6px 0 0; padding: 6px 8px; border-radius: 8px; font-size: 12px; background: rgba(251,188,4,0.14); color: #fde293; }
.notice.bad { background: rgba(234,67,53,0.16); color: #f6aea9; }
.clone { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: #bdc1c6; }
.clone input { margin: 2px 0 0; accent-color: #8ab4f8; }
.clone .state { color: #9aa0a6; }
.footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.07); }
.usage { font-size: 11px; color: #80868b; line-height: 1.35; }
.btn { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 8px; font-size: 12px; background: rgba(255,255,255,0.09); color: #e8eaed; white-space: nowrap; }
.btn:hover { background: rgba(255,255,255,0.16); }
.meter { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; margin: 3px 0 8px; }
.meter > div { height: 100%; width: 0; background: #34a853; transition: width 0.25s; }
[hidden] { display: none !important; }
`;

// The panel's shadow root is open, so a script in Meet's page can reach its controls,
// but it cannot make a trusted event. Only the person's own clicks and keys count.
function trusted(handler) {
  return (event) => {
    if (event.isTrusted) handler(event);
  };
}

// A scripted click() still flips a checkbox and the browser then fires a trusted change,
// and a click on a label is passed on to its control by the browser itself. So an
// untrusted click is cancelled before it does anything, on controls and on labels.
function blockScriptedClicks(event) {
  if (event.isTrusted) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), trusted(value));
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  if (props.onclick || props.onchange || tag === 'label') el.addEventListener('click', blockScriptedClicks, true);
  for (const child of children) if (child) el.append(child);
  return el;
}

function segmented(options, value, onChange) {
  const el = h('div', { class: 'seg', role: 'radiogroup' });
  const buttons = new Map();
  const set = (selected) => {
    for (const [key, button] of buttons) {
      button.classList.toggle('on', key === selected);
      button.setAttribute('aria-checked', String(key === selected));
    }
  };
  for (const [key, label] of options) {
    const button = h('button', {
      class: 'seg-btn',
      role: 'radio',
      text: label,
      onclick: () => {
        set(key);
        onChange(key);
      },
    });
    buttons.set(key, button);
    el.append(button);
  }
  set(value);
  return { el, set };
}

export class Overlay {
  constructor({ hello, onOptions, onChime, onStop }) {
    this.hello = hello;
    this.onOptions = onOptions;
    this.onChime = onChime;
    this.onStop = onStop;
    this.items = { in: [], out: [] };
    this.incomingMode = hello.incomingMode;
    this.outgoingMode = hello.outgoingMode;
    this.build();
  }

  build() {
    const { hello } = this;
    const mine = languageLabel(hello.myLanguage);
    const theirs = languageLabel(hello.theirLanguage);

    this.host = h('div', { id: 'meet-tercuman-overlay' });
    const root = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];

    this.dot = h('span', { class: 'dot wait' });
    this.meta = h('span', { class: 'meta', text: t('overlay.connecting') });
    this.rec = h('span', { class: 'rec', text: `● ${t('overlay.recording')}`, hidden: true });
    this.debugBadge = h('span', { class: 'rec debug', text: t('overlay.debug'), title: t('overlay.debugTitle'), hidden: true });
    const header = h(
      'div',
      { class: 'header' },
      this.dot,
      h('span', { class: 'headline', text: hello.diagnostic ? t('overlay.diagTitle') : t('app.name') }),
      this.rec,
      this.debugBadge,
      this.meta,
      h('button', { class: 'icon', title: t('overlay.minimize'), text: '−', onclick: () => this.panel.classList.toggle('min') }),
      h('button', { class: 'icon stop', title: t('overlay.stop'), text: '■', onclick: () => this.onStop() }),
    );
    this.body = h('div', { class: 'body' });
    this.panel = h('div', { class: 'panel' }, header, this.body);
    root.append(this.panel);

    if (hello.diagnostic) this.buildDiagnostic();
    else this.buildTranslation(mine, theirs);

    // Notices and the footer stay visible below the scrolling subtitles.
    this.notices = h('div', {});
    this.usage = h('span', { class: 'usage' });
    this.panel.append(
      h(
        'div',
        { class: 'bottom' },
        this.notices,
        h('div', { class: 'footer' }, this.usage, h('button', { class: 'btn', text: t('popup.chime'), title: t('overlay.chimeTitle'), onclick: () => this.onChime() })),
      ),
    );

    this.makeDraggable(header);
    this.applyMode();
    (document.body || document.documentElement).append(this.host);
  }

  buildTranslation(mine, theirs) {
    this.inModes = segmented(
      [
        ['voice', t('mode.short.voice')],
        ['text', t('mode.short.text')],
        ['off', t('mode.short.off')],
      ],
      this.incomingMode,
      (mode) => {
        this.incomingMode = mode;
        this.applyMode();
        this.onOptions({ incomingMode: mode });
      },
    );
    this.inList = h('div', { class: 'list' });
    this.inEmpty = h('div', { class: 'empty', text: t('overlay.inEmpty') });
    this.inLive = h('div', { class: 'live', hidden: true });
    // Consent is read in the person's own click on the box (or its label). A change event
    // can follow a scripted click as trusted, and a listener in Meet's page can keep that
    // click from reaching this one, so change is never used; status() shows the real value.
    this.cloneBox = h('input', {
      type: 'checkbox',
      onclick: () => {
        this.consentClickedAt = Date.now();
        this.onOptions({ cloneConsent: this.cloneBox.checked });
      },
    });
    this.cloneBox.checked = Boolean(this.hello.cloneConsent);
    this.cloneState = h('span', { class: 'state' });
    this.cloneRow = h(
      'label',
      { class: 'clone' },
      this.cloneBox,
      h('span', {}, t('overlay.consent'), this.cloneState),
    );
    this.cloneRow.hidden = !this.hello.offerClone;
    this.incomingSection = h(
      'section',
      { class: 'incoming' },
      h('div', { class: 'row' }, h('span', { class: 'label', text: t('overlay.inLabel', { from: theirs, to: mine }) }), this.inModes.el),
      this.inList,
      this.inEmpty,
      this.inLive,
      this.cloneRow,
    );

    this.outModes = segmented(
      [
        ['voice', t('mode.short.voice')],
        ['off', t('mode.short.off')],
      ],
      this.outgoingMode,
      (mode) => {
        this.outgoingMode = mode;
        this.applyMode();
        this.onOptions({ outgoingMode: mode });
      },
    );
    this.outList = h('div', { class: 'list' });
    this.outLive = h('div', { class: 'live', hidden: true });
    this.outgoingSection = h(
      'section',
      { class: 'outgoing' },
      h('div', { class: 'row' }, h('span', { class: 'label', text: t('overlay.outLabel', { from: mine, to: theirs }) }), this.outModes.el),
      this.outList,
      this.outLive,
    );
    this.body.append(this.incomingSection, this.outgoingSection);
  }

  buildDiagnostic() {
    this.tabMeter = h('div');
    this.micMeter = h('div');
    this.body.append(
      h(
        'section',
        {},
        h('div', { class: 'label', text: t('overlay.diagTab') }),
        h('div', { class: 'meter' }, this.tabMeter),
        h('div', { class: 'label', text: t('overlay.diagMic') }),
        h('div', { class: 'meter' }, this.micMeter),
        h('div', {
          class: 'empty',
          text: t('overlay.diagHelp'),
        }),
      ),
    );
  }

  applyMode() {
    this.panel.classList.toggle('text-mode', this.incomingMode === 'text');
    if (this.cloneRow) this.cloneRow.hidden = !this.hello.offerClone || this.incomingMode !== 'voice';
  }

  modes({ incomingMode, outgoingMode, cloneConsent }) {
    if (incomingMode) {
      this.incomingMode = incomingMode;
      this.inModes?.set(incomingMode);
    }
    if (outgoingMode) {
      this.outgoingMode = outgoingMode;
      this.outModes?.set(outgoingMode);
    }
    if (cloneConsent !== undefined && this.cloneBox) this.cloneBox.checked = cloneConsent;
    this.applyMode();
  }

  caption(msg) {
    if (this.hello.diagnostic || msg.phase === 'echo') return;
    const dir = msg.dir === 'out' ? 'out' : 'in';
    const list = dir === 'in' ? this.inList : this.outList;
    const live = dir === 'in' ? this.inLive : this.outLive;
    if (msg.phase === 'speech-error') {
      const item = this.items[dir].find((x) => x.id === msg.id);
      if (!item) return;
      item.note ||= item.el.appendChild(h('div', { class: 'note' }));
      item.note.textContent = msg.error;
      return;
    }
    if (msg.phase === 'partial') {
      live.textContent = msg.source || '';
      live.hidden = !msg.source;
      return;
    }
    live.textContent = '';
    live.hidden = true;
    if (dir === 'in') this.inEmpty.hidden = true;

    let item = this.items[dir].find((x) => x.id === msg.id);
    if (!item) {
      const translation = h('div', { class: 'tr' });
      const source = h('div', { class: 'src' });
      item = { id: msg.id, el: h('div', { class: 'item' }, translation, source), translation, source };
      this.items[dir].push(item);
      list.append(item.el);
      const max = dir === 'in' ? 3 : 2;
      while (this.items[dir].length > max) this.items[dir].shift().el.remove();
    }
    if (msg.source) item.source.textContent = msg.source;
    if (msg.phase === 'committed') {
      item.translation.textContent = '…';
      item.el.classList.add('pending');
    }
    if (msg.translation) {
      item.translation.textContent = msg.translation;
      item.el.classList.remove('pending');
    }
    if (msg.phase === 'error') {
      item.translation.textContent = msg.error;
      item.el.classList.remove('pending');
      item.el.classList.add('error');
    }
    this.body.scrollTop = this.body.scrollHeight;
  }

  clone(clone) {
    if (!this.cloneState) return;
    const text = {
      collecting: t('clone.collecting', { s: clone.seconds || 0, target: clone.target || 45 }),
      creating: t('clone.creating'),
      ready: t('clone.ready'),
      failed: t('clone.failed', { error: clone.error || '' }),
    }[clone.state];
    this.cloneState.textContent = text || '';
  }

  status(status) {
    if (!status) return;
    this.lastStatus = status;
    this.rec.hidden = !status.recording;
    if (this.cloneBox && Date.now() - (this.consentClickedAt || 0) > 2000) this.cloneBox.checked = Boolean(status.cloneConsent);
    this.debugBadge.hidden = !status.debugCopies;
    const sttStates = Object.values(status.stt || {}).filter((s) => s !== 'off');
    const healthy = status.page.connected && sttStates.every((s) => s === 'ready');
    const connecting = sttStates.some((s) => s === 'connecting' || s === 'reconnecting');
    this.dot.className = `dot ${status.error ? 'bad' : healthy || status.diagnostic ? 'ok' : connecting ? 'wait' : 'wait'}`;
    if (status.diagnostic) this.meta.textContent = status.page.connected ? t('overlay.ready') : t('overlay.connecting');
    else if (status.latencyMs != null) this.meta.textContent = t('overlay.latency', { n: num(status.latencyMs / 1000, 1) });
    else this.meta.textContent = connecting ? t('overlay.connecting') : t('overlay.listening');
    this.usage.textContent = status.diagnostic ? '' : formatUsage(status.usage);

    if (this.tabMeter) {
      this.tabMeter.style.width = `${Math.min(100, Math.round(status.levels.tab * 400))}%`;
      this.micMeter.style.width = `${Math.min(100, Math.round(status.levels.mic * 400))}%`;
    }

    const notices = [];
    if (status.error) notices.push([status.error, true]);
    const wantsToSend = status.diagnostic || status.outgoingMode === 'voice';
    if (wantsToSend && status.page.connected && status.page.ctxState === 'suspended') {
      notices.push([t('overlay.notice.click'), false]);
    }
    if (!status.diagnostic && status.outgoingMode === 'voice' && status.page.connected && status.page.unattached) {
      notices.push([t('overlay.notice.unattached'), true]);
    } else if (!status.diagnostic && status.outgoingMode === 'voice' && status.page.connected && status.page.muted) {
      notices.push([t('overlay.notice.muted'), false]);
    }
    if (sttStates.includes('reconnecting')) notices.push([t('overlay.notice.reconnecting'), false]);
    for (const warning of status.warnings || []) notices.push([warning, false]);
    this.notices.replaceChildren(...notices.map(([text, bad]) => h('div', { class: `notice${bad ? ' bad' : ''}`, text })));
  }

  setDisconnected() {
    this.dot.className = 'dot bad';
    this.meta.textContent = t('overlay.disconnected');
  }

  makeDraggable(handle) {
    const KEY = 'meet-tercuman-overlay-pos';
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved) this.place(saved.left, saved.top);
    } catch {
      // position is a convenience only
    }
    handle.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = this.panel.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = (e) => this.place(e.clientX - dx, e.clientY - dy);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        try {
          const r = this.panel.getBoundingClientRect();
          localStorage.setItem(KEY, JSON.stringify({ left: r.left, top: r.top }));
        } catch {
          // ignore
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  place(left, top) {
    const maxLeft = window.innerWidth - 120;
    const maxTop = window.innerHeight - 40;
    this.panel.style.left = `${Math.max(0, Math.min(maxLeft, left))}px`;
    this.panel.style.top = `${Math.max(0, Math.min(maxTop, top))}px`;
    this.panel.style.bottom = 'auto';
  }

  destroy() {
    this.host.remove();
  }
}
