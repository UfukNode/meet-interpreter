// What they say, translated, shown like film subtitles low in the Meet window: above
// Meet's own controls, and above Meet's captions when those are on. Only the translation
// shows, unless the settings ask for their own words under it too. While they are still
// talking, a dimmed draft (their words so far, translated on this computer) stands where
// the sentence's translation will come. Each line stays long enough to read. It never
// takes a click, so Meet stays usable underneath. The panel keeps the full history.

const CSS = `
:host { all: initial; }
.bar {
  position: fixed; left: 50%; bottom: 104px; transform: translateX(-50%); z-index: 2147482999;
  width: max-content; max-width: min(960px, 86vw); pointer-events: none;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  font-family: "Google Sans", Roboto, "Segoe UI", system-ui, sans-serif;
  opacity: 1; transition: opacity 0.4s ease;
}
.bar.hidden { opacity: 0; }
.line {
  background: rgba(14, 16, 20, 0.82); color: #fff; border-radius: 10px; padding: 7px 16px 8px;
  text-align: center; box-shadow: 0 2px 14px rgba(0, 0, 0, 0.35);
}
.line .tr { font-size: 24px; line-height: 1.3; font-weight: 500; text-wrap: balance; }
.line .src { font-size: 13px; line-height: 1.35; color: #bdc1c6; margin-top: 2px; text-wrap: balance; }
.line .src:empty { display: none; }
.line.old { opacity: 0.6; }
.line.old .tr { font-size: 18px; }
.line.draft { background: rgba(14, 16, 20, 0.62); }
.line.draft .tr { color: #dfe3e8; font-style: italic; }
@media (max-width: 760px) {
  .line .tr { font-size: 18px; }
  .line.old .tr { font-size: 15px; }
}
`;

const KEEP = 2; // lines on screen at most, a draft included
const ABOVE_CONTROLS = 104;

// Long enough to read a line, at about 15 characters a second, plus a moment to look.
export function readingMs(text) {
  return Math.min(12000, Math.max(4000, 1500 + String(text || '').length * 70));
}

export class SubtitleBar {
  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'meet-tercuman-subtitles';
    const root = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
    this.bar = document.createElement('div');
    this.bar.className = 'bar hidden';
    root.append(this.bar);
    document.body.append(this.host);
    this.lines = [];
    this.draft = null;
    this.enabled = true;
    this.showOriginal = false;
    this.fadeTimer = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.clear();
  }

  // Their own words under each translation, or only the translation (the default).
  setOriginal(on) {
    this.showOriginal = Boolean(on);
    for (const line of this.lines) line.src.textContent = this.showOriginal ? line.source || '' : '';
  }

  // Captions from the engine; only the translation of what they said is shown.
  caption(msg) {
    if (!this.enabled || msg.dir === 'out') return;
    if (msg.phase === 'draft') {
      this.showDraft(msg.translation);
      return;
    }
    if (!msg.translation || (msg.phase !== 'translating' && msg.phase !== 'translated')) return;
    let line = this.lines.find((l) => l.id === msg.id);
    if (!line) {
      // The sentence's own translation takes its draft's place.
      this.dropDraft();
      line = makeLine(msg.id);
      this.lines.push(line);
      this.bar.append(line.el);
    }
    line.tr.textContent = msg.translation;
    line.source = msg.source || '';
    line.src.textContent = this.showOriginal ? line.source : '';
    this.fit();
    this.show(msg.translation);
  }

  showDraft(text) {
    if (!text) {
      this.dropDraft();
      this.fit();
      if (!this.lines.length) this.bar.classList.add('hidden');
      return;
    }
    if (!this.draft) {
      this.draft = makeLine(null);
      this.draft.el.classList.add('draft');
    }
    this.draft.tr.textContent = text;
    this.bar.append(this.draft.el); // always the newest line
    this.fit();
    this.show(text);
  }

  dropDraft() {
    this.draft?.el.remove();
    this.draft = null;
  }

  // At most KEEP lines, the draft included; only finished lines that a newer finished
  // line follows are dimmed.
  fit() {
    while (this.lines.length > KEEP - (this.draft ? 1 : 0)) this.lines.shift().el.remove();
    this.lines.forEach((l, i) => l.el.classList.toggle('old', i < this.lines.length - 1));
  }

  show(text) {
    this.place();
    this.bar.classList.remove('hidden');
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => this.bar.classList.add('hidden'), readingMs(text));
  }

  // Meet's own captions sit in the same place; when they are showing, go above them. When
  // the panel is where the centred subtitles would be, use the wider free side next to it.
  place() {
    let bottom = ABOVE_CONTROLS;
    const captions = document.querySelector('[role="region"][aria-label*="aption" i], [role="region"][aria-label*="ltyaz" i]');
    const box = captions?.getBoundingClientRect();
    if (box && box.height > 0 && box.top > 0) bottom = Math.max(bottom, Math.round(window.innerHeight - box.top + 10));
    let left = 16;
    let right = window.innerWidth - 16;
    const panel = document.getElementById('meet-tercuman-overlay')?.shadowRoot?.querySelector('.panel')?.getBoundingClientRect();
    // Measured at full width, as the subtitles would stand centred with nothing in the way.
    this.bar.style.maxWidth = `${Math.min(960, right - left)}px`;
    const { width, height } = this.bar.getBoundingClientRect();
    const middle = window.innerWidth / 2;
    const bandBottom = window.innerHeight - bottom;
    const bandTop = bandBottom - Math.max(90, height);
    const inTheWay = panel?.width && panel.left < middle + width / 2 + 16 && panel.right > middle - width / 2 - 16;
    if (inTheWay && panel.top < bandBottom && panel.bottom > bandTop) {
      if (right - panel.right >= panel.left - left) left = panel.right + 16;
      else right = panel.left - 16;
    }
    this.bar.style.left = `${Math.round((left + right) / 2)}px`;
    this.bar.style.maxWidth = `${Math.max(240, Math.min(960, right - left))}px`;
    this.bar.style.bottom = `${bottom}px`;
  }

  clear() {
    clearTimeout(this.fadeTimer);
    for (const line of this.lines) line.el.remove();
    this.lines = [];
    this.dropDraft();
    this.bar.classList.add('hidden');
  }

  destroy() {
    clearTimeout(this.fadeTimer);
    this.host.remove();
  }
}

function makeLine(id) {
  const tr = document.createElement('div');
  tr.className = 'tr';
  const src = document.createElement('div');
  src.className = 'src';
  const el = document.createElement('div');
  el.className = 'line';
  el.append(tr, src);
  return { id, el, tr, src };
}
