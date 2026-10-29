import Anthropic from '@anthropic-ai/sdk';
import { loadSettings, saveSettings, isFreeTranslation, TRANSLATION_MODELS, TTS_MODELS } from '../shared/settings.js';
import { LANGUAGES } from '../shared/languages.js';
import { setLanguage, t, applyI18n, languageLabel } from '../shared/i18n.js';
import { listVoices, createVoiceClone, deleteVoice, speechStream, describeElevenLabsError } from '../shared/elevenlabs.js';
import { describeClaudeError } from '../offscreen/translator.js';
import { checkFreeKey, FREE_KEY_NAMES } from '../offscreen/free-translator.js';
import { localPairs, localTranslationState, prepareLocalTranslation } from '../shared/local-translation.js';
import { PcmByteAligner, encodeWav, float32ToInt16 } from '../shared/pcm.js';
import { PcmScheduler } from '../shared/scheduler.js';

const $ = (id) => document.getElementById(id);

// The text to read for a voice clone is in the language the person speaks.
const READING_TEXTS = {};
READING_TEXTS.tr =
  'Merhaba, bu kaydı sesimi tanıtmak için yapıyorum. Günlük hayatta insanlarla konuşmayı, yeni fikirleri tartışmayı ve birlikte bir şeyler üretmeyi seviyorum. ' +
  'Toplantılarda genellikle sakin ve anlaşılır konuşurum, ama heyecanlandığımda biraz hızlanırım. Bugün hava oldukça güzel; akşam arkadaşlarımla buluşup bir şeyler yemeyi düşünüyorum. ' +
  'Bazen bir soru sorarım, değil mi? Bazen de bir şeyi net bir şekilde açıklarım. Sayıları ve tarihleri de söyleyeyim: on iki Mart, saat on dört otuz, yüz yirmi beş lira. ' +
  'İstanbul, Ankara ve İzmir arasında sık sık yolculuk ederim. Teknoloji, yazılım ve tasarım üzerine çalışıyorum; yeni araçları denemek ve onları gerçek işlerde kullanmak hoşuma gidiyor. ' +
  'Bir projeyi anlatırken önce amacını, sonra nasıl çalıştığını ve en son neden önemli olduğunu söylerim. Son olarak, bu kaydı sessiz bir odada, her zamanki konuşma sesimle yapıyorum. Teşekkür ederim.';
READING_TEXTS.en =
  "Hello, I'm making this recording so my voice can be recognized. In everyday life I enjoy talking with people, discussing new ideas and building things together. " +
  'In meetings I usually speak calmly and clearly, but I speed up a little when I get excited. The weather is quite nice today; this evening I plan to meet my friends for dinner. ' +
  "Sometimes I ask a question, don't I? Other times I explain something plainly. Let me say some numbers and dates too: the twelfth of March, half past two in the afternoon, one hundred and twenty-five dollars. " +
  'I often travel between London, New York and Istanbul. I work on technology, software and design, and I like trying new tools and using them in real work. ' +
  'When I describe a project, I first explain its goal, then how it works, and finally why it matters. Finally, I am recording this in a quiet room with my usual speaking voice. Thank you.';

const PREVIEW_TEXT = {
  tr: 'Merhaba! Görüşme boyunca çeviriyi bu sesle duyacaksınız.',
  en: 'Hello! This is how the translated voice will sound during our call.',
  de: 'Hallo! So klingt die übersetzte Stimme während unseres Gesprächs.',
  fr: 'Bonjour ! Voici la voix traduite pendant notre appel.',
  es: '¡Hola! Así sonará la voz traducida durante nuestra llamada.',
};

let settings;
let voices = [];

// ---- small helpers ---------------------------------------------------------------------

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 1600);
}

function result(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `result ${kind}`;
}

let pending = {};
let saveTimer;
function save(patch, { quiet = false } = {}) {
  Object.assign(settings, patch);
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const batch = pending;
    pending = {};
    await saveSettings(batch);
    if (!quiet) toast(t('opt.saved'));
    refreshChecklist();
  }, 300);
}

function fillSelect(select, items, value) {
  select.replaceChildren(...items.map(([v, label]) => new Option(label, v, false, v === value)));
}

// ---- fields ----------------------------------------------------------------------------

function bindText(id) {
  const el = $(id);
  el.value = settings[id] ?? '';
  el.addEventListener('input', () => save({ [id]: el.value.trim() }));
}

function bindSelect(id, parse = (v) => v) {
  const el = $(id);
  el.value = String(settings[id]);
  el.addEventListener('change', () => save({ [id]: parse(el.value) }));
}

function bindCheck(id) {
  const el = $(id);
  el.checked = Boolean(settings[id]);
  el.addEventListener('change', () => save({ [id]: el.checked }));
}

function bindSlider(id) {
  const el = $(id);
  const out = el.parentElement.querySelector('output');
  const show = () => (out.textContent = `${Math.round(Number(el.value) * 100)}%`);
  el.value = String(settings[id]);
  show();
  el.addEventListener('input', () => {
    show();
    save({ [id]: Number(el.value) }, { quiet: true });
  });
}

// ---- setup checklist -------------------------------------------------------------------

async function micGranted() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'prompt';
  }
}

async function refreshChecklist() {
  const free = isFreeTranslation(settings);
  $('check-elevenlabs').classList.toggle('done', Boolean(settings.elevenLabsKey));
  $('check-anthropic').textContent = free ? t('opt.check.anthropicFree') : t('opt.check.anthropic');
  $('check-anthropic').classList.toggle('done', free ? localState === 'ready' || FREE_KEY_NAMES.some((k) => settings[k]) : Boolean(settings.anthropicKey));
  $('check-mic').classList.toggle('done', (await micGranted()) === 'granted');
  $('check-voice').classList.toggle('done', Boolean(settings.myVoiceId));
}

// ---- keys ------------------------------------------------------------------------------

async function testKeys() {
  const parts = [];
  let ok = true;
  if (settings.elevenLabsKey) {
    try {
      voices = await listVoices(settings.elevenLabsKey);
      parts.push(t('opt.keys.elOk', { n: voices.length }));
      renderVoices();
    } catch (err) {
      ok = false;
      parts.push(`ElevenLabs: ${describeElevenLabsError(err)}`);
    }
  } else {
    ok = false;
    parts.push(t('opt.keys.elMissing'));
  }
  if (isFreeTranslation(settings)) {
    parts.push(t('opt.keys.freeNoAnthropic'));
  } else if (settings.anthropicKey) {
    try {
      const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
      await client.models.retrieve(settings.claudeModel);
      parts.push(t('opt.keys.anOk'));
    } catch (err) {
      ok = false;
      parts.push(`Anthropic: ${describeClaudeError(err)}`);
    }
  } else {
    ok = false;
    parts.push(t('opt.keys.anMissing'));
  }
  result('keyResult', parts.join(' '), ok ? 'ok' : 'bad');
}

// ---- free translation ------------------------------------------------------------------

let localState = 'unknown';

const LOCAL_STATE_TEXT = {
  ready: ['local.ready', 'ok'],
  download: ['local.download', ''],
  unavailable: ['local.unavailable', 'bad'],
  unsupported: ['local.unsupported', 'bad'],
};

function showLocalState(state) {
  localState = state;
  const [key, kind] = LOCAL_STATE_TEXT[state] || ['', ''];
  const text = key ? t(key) : '';
  $('freeState').textContent = text;
  $('freeState').className = `pill ${kind}`;
  $('prepareFree').hidden = state !== 'download';
  refreshChecklist();
}

async function renderFree() {
  const free = isFreeTranslation(settings);
  $('freeBox').hidden = !free;
  $('claudeHint').hidden = free;
  if (free) showLocalState(await localTranslationState(localPairs(settings)));
}

// Runs from a click or a change, which Chrome needs before it downloads language packs.
async function prepareFree() {
  if (!isFreeTranslation(settings)) return;
  $('prepareFree').disabled = true;
  $('freeState').className = 'pill';
  $('freeState').textContent = t('local.preparing');
  const pairs = localPairs(settings);
  const prepared = prepareLocalTranslation(pairs, {
    onProgress: (loaded) => ($('freeState').textContent = t('local.preparingPct', { n: Math.round(loaded * 100) })),
  });
  // A stalled download (offline, for example) must not leave the page waiting forever.
  const state = await Promise.race([prepared, new Promise((resolve) => setTimeout(() => resolve(localTranslationState(pairs)), 60000))]);
  $('prepareFree').disabled = false;
  showLocalState(state);
}

async function testFreeKeys() {
  const names = FREE_KEY_NAMES.filter((name) => settings[name]);
  if (!names.length) return result('freeKeyResult', t('opt.tr.noFreeKeys'));
  result('freeKeyResult', t('opt.testing'));
  const checks = await Promise.all(names.map((name) => checkFreeKey(name, settings[name])));
  result('freeKeyResult', checks.map((c) => c.message).join(' '), checks.every((c) => c.ok) ? 'ok' : 'bad');
}

// ---- microphone and devices ------------------------------------------------------------

async function grantMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    $('micState').textContent = t('opt.mic.denied', { name: err.name });
    $('micState').className = 'pill bad';
    return;
  }
  await refreshMic();
  await refreshDevices();
}

async function refreshMic() {
  const state = await micGranted();
  const el = $('micState');
  el.textContent = state === 'granted' ? t('opt.mic.granted') : state === 'denied' ? t('opt.mic.blocked') : t('opt.mic.notYet');
  el.className = `pill ${state === 'granted' ? 'ok' : state === 'denied' ? 'bad' : ''}`;
  $('grantMic').hidden = state === 'granted';
  refreshChecklist();
}

async function refreshDevices() {
  if ((await micGranted()) !== 'granted') return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const named = (kind) =>
    [...new Map(devices.filter((d) => d.kind === kind && d.label && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => [d.label, d])).values()];
  fillSelect($('micDeviceLabel'), [['', t('opt.mic.sameAsMeet')], ...named('audioinput').map((d) => [d.label, d.label])], settings.micDeviceLabel);
  fillSelect($('outputDeviceLabel'), [['', t('opt.mic.systemDefault')], ...named('audiooutput').map((d) => [d.label, d.label])], settings.outputDeviceLabel);
}

// ---- voices ----------------------------------------------------------------------------

function voiceOptions(placeholder) {
  const own = voices.filter((v) => v.category !== 'premade');
  const premade = voices.filter((v) => v.category === 'premade');
  const options = [['', placeholder]];
  const gender = (g) => (g === 'male' ? t('opt.voice.male') : g === 'female' ? t('opt.voice.female') : g);
  for (const v of own) options.push([v.voice_id, t('opt.voice.yours', { name: v.name })]);
  for (const v of premade) options.push([v.voice_id, `${v.name}${v.labels?.gender ? `, ${gender(v.labels.gender)}` : ''}`]);
  return options;
}

function renderVoices() {
  $('myVoiceName').textContent = settings.myVoiceName || t('opt.voice.none');
  if (!voices.length) return; // keep the "enter the key first" placeholders
  fillSelect($('myVoiceSelect'), voiceOptions(t('opt.voice.pickPlaceholder')), settings.myVoiceId);
  fillSelect($('theirVoiceSelect'), voiceOptions(t('opt.their.auto')), settings.theirVoiceId);
}

async function loadVoices() {
  if (!settings.elevenLabsKey) return;
  try {
    voices = await listVoices(settings.elevenLabsKey);
    renderVoices();
  } catch (err) {
    result('myVoiceResult', describeElevenLabsError(err), 'bad');
  }
}

let previewCtx;
async function preview(voiceId, languageCode) {
  if (!settings.elevenLabsKey) return toast(t('opt.voice.needKey'));
  if (!voiceId) return toast(t('opt.voice.needVoice'));
  try {
    previewCtx ||= new AudioContext();
    await previewCtx.resume();
    const player = new PcmScheduler(previewCtx, previewCtx.destination);
    const response = await speechStream(settings.elevenLabsKey, {
      voiceId,
      text: PREVIEW_TEXT[languageCode] || PREVIEW_TEXT.en,
      modelId: settings.ttsModel,
      languageCode,
    });
    const reader = response.body.getReader();
    const aligner = new PcmByteAligner();
    const id = `preview-${Date.now()}`;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const samples = aligner.push(value);
      if (samples.length) player.push(id, samples);
    }
    player.end(id);
  } catch (err) {
    toast(describeElevenLabsError(err));
  }
}

async function createMyVoice(files) {
  if (!settings.elevenLabsKey) return result('myVoiceResult', t('opt.voice.needKey'), 'bad');
  result('myVoiceResult', t('opt.voice.creating'));
  const name = t('opt.voice.cloneName');
  try {
    const created = await createVoiceClone(settings.elevenLabsKey, {
      name,
      files,
      description: 'My own voice, cloned from my recording for live call translation.',
    });
    const previous = settings.myVoiceOwnedId;
    save({ myVoiceId: created.voice_id, myVoiceName: name, myVoiceOwnedId: created.voice_id });
    if (previous && previous !== created.voice_id) deleteVoice(settings.elevenLabsKey, previous).catch(() => {});
    await loadVoices();
    result('myVoiceResult', t('opt.voice.ready'), 'ok');
  } catch (err) {
    result('myVoiceResult', describeElevenLabsError(err), 'bad');
  }
}

// ---- recording -------------------------------------------------------------------------

let recorder = null;
let recordedWav = null;
let recordLabel = 'opt.voice.record';

async function toggleRecording() {
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    result('myVoiceResult', t('opt.voice.micFail', { name: err.name }), 'bad');
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $('recordTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 180) recorder?.stop();
  }, 250);
  recorder.onstop = async () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    recordLabel = 'opt.voice.rerecord';
    $('recordBtn').textContent = t(recordLabel);
    $('recordBtn').classList.remove('recording');
    const seconds = (Date.now() - startedAt) / 1000;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    $('recordPreview').src = URL.createObjectURL(blob);
    $('recordPreview').hidden = false;
    recordedWav = await toWav(blob);
    const enough = seconds >= 30;
    $('cloneRecording').disabled = !enough || !recordedWav;
    result(
      'myVoiceResult',
      enough ? t('opt.voice.recordDone') : t('opt.voice.tooShort'),
      enough ? '' : 'bad',
    );
  };
  recorder.start(1000);
  recordLabel = 'opt.voice.stopRecord';
  $('recordBtn').textContent = t(recordLabel);
  $('recordBtn').classList.add('recording');
  $('cloneRecording').disabled = true;
  result('myVoiceResult', t('opt.voice.recording'));
}

async function toWav(blob) {
  try {
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    await ctx.close();
    const mono = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
    return new Blob([encodeWav(float32ToInt16(mono), buffer.sampleRate)], { type: 'audio/wav' });
  } catch {
    return null;
  }
}

// ---- start -----------------------------------------------------------------------------

// Everything on the page that depends on the interface language.
function renderTexts() {
  setLanguage(settings.uiLanguage);
  applyI18n();
  document.title = t('opt.title');
  for (const button of $('uiLanguage').querySelectorAll('button')) {
    button.setAttribute('aria-checked', String(button.dataset.value === settings.uiLanguage));
  }
  $('readingText').textContent = READING_TEXTS[settings.myLanguage] || READING_TEXTS.en;
  const languages = LANGUAGES.map((l) => [l.code, languageLabel(l.code)]);
  fillSelect($('myLanguage'), languages, settings.myLanguage);
  fillSelect($('theirLanguage'), languages, settings.theirLanguage);
  fillSelect($('claudeModel'), TRANSLATION_MODELS.map((m) => [m.id, t(m.labelKey)]), settings.claudeModel);
  fillSelect($('ttsModel'), TTS_MODELS.map((m) => [m.id, t(m.labelKey)]), settings.ttsModel);
  fillSelect($('cloneSeconds'), [30, 45, 60, 90].map((n) => [String(n), t('opt.their.secondsOption', { n })]), String(settings.cloneSeconds));
  $('vadSilenceSecs').value = String(settings.vadSilenceSecs);
  $('showKeys').textContent = t($('elevenLabsKey').type === 'password' ? 'opt.keys.show' : 'opt.keys.hide');
  $('recordBtn').textContent = t(recordLabel);
  renderVoices();
  showLocalState(localState);
  refreshMic();
  refreshDevices();
  refreshChecklist();
}

async function init() {
  settings = await loadSettings();
  renderTexts();
  for (const button of $('uiLanguage').querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      settings = await saveSettings({ uiLanguage: button.dataset.value });
      renderTexts();
    });
  }

  bindText('elevenLabsKey');
  bindText('anthropicKey');
  for (const id of FREE_KEY_NAMES) bindText(id);
  bindText('meetingContext');
  bindText('keyterms');
  for (const id of ['myLanguage', 'theirLanguage', 'claudeModel', 'ttsModel', 'micDeviceLabel', 'outputDeviceLabel']) bindSelect(id);
  bindSelect('vadSilenceSecs', Number);
  bindSelect('cloneSeconds', Number);
  for (const id of ['offerTheirClone', 'deleteCloneAfter', 'halfDuplex', 'showOverlay', 'subtitleBar']) bindCheck(id);
  for (const id of ['translationVolume', 'originalVolume', 'duckVolume', 'monitorVolume', 'stability', 'similarity']) bindSlider(id);

  $('elevenLabsKey').addEventListener('change', loadVoices);
  $('showKeys').addEventListener('click', () => {
    const show = $('elevenLabsKey').type === 'password';
    for (const id of ['elevenLabsKey', 'anthropicKey', ...FREE_KEY_NAMES]) $(id).type = show ? 'text' : 'password';
    $('showKeys').textContent = show ? t('opt.keys.hide') : t('opt.keys.show');
  });
  $('claudeModel').addEventListener('change', async () => {
    await renderFree();
    if (localState === 'download') prepareFree();
  });
  for (const id of ['myLanguage', 'theirLanguage']) {
    $(id).addEventListener('change', async () => {
      $('readingText').textContent = READING_TEXTS[settings.myLanguage] || READING_TEXTS.en;
      await renderFree();
      if (localState === 'download') prepareFree();
    });
  }
  $('prepareFree').addEventListener('click', prepareFree);
  $('testFreeKeys').addEventListener('click', async () => {
    $('testFreeKeys').disabled = true;
    await testFreeKeys();
    $('testFreeKeys').disabled = false;
  });
  if (FREE_KEY_NAMES.some((id) => settings[id])) $('freeKeys').open = true;
  $('testKeys').addEventListener('click', async () => {
    $('testKeys').disabled = true;
    result('keyResult', t('opt.testing'));
    await testKeys();
    $('testKeys').disabled = false;
  });
  $('grantMic').addEventListener('click', grantMic);

  $('myVoiceSelect').addEventListener('change', () => {
    const voice = voices.find((v) => v.voice_id === $('myVoiceSelect').value);
    save({ myVoiceId: voice?.voice_id || '', myVoiceName: voice?.name || '' });
    renderVoices();
  });
  $('theirVoiceSelect').addEventListener('change', () => {
    const voice = voices.find((v) => v.voice_id === $('theirVoiceSelect').value);
    save({ theirVoiceId: voice?.voice_id || '', theirVoiceName: voice?.name || '' });
  });
  $('previewMine').addEventListener('click', () => preview(settings.myVoiceId, settings.theirLanguage));
  $('previewTheirs').addEventListener('click', () => {
    const id = settings.theirVoiceId || voices.find((v) => v.category === 'premade')?.voice_id;
    preview(id, settings.myLanguage);
  });
  $('recordBtn').addEventListener('click', toggleRecording);
  $('cloneRecording').addEventListener('click', () => {
    if (recordedWav) createMyVoice([{ blob: recordedWav, filename: 'benim-sesim.wav' }]);
  });
  $('voiceFiles').addEventListener('change', () => {
    const files = [...$('voiceFiles').files].map((f) => ({ blob: f, filename: f.name }));
    if (files.length) createMyVoice(files);
  });

  renderVoices();
  await renderFree();
  await refreshMic();
  await refreshDevices();
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  loadVoices();
}

init();
