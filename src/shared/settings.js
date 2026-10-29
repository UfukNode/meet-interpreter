// Persistent settings live in chrome.storage.local under one key. Everything the
// extension needs at runtime is read through loadSettings(), so new fields only
// need a default here.

// Labels are i18n keys (see shared/i18n.js).
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', labelKey: 'model.opus' },
  { id: 'claude-sonnet-5-5', labelKey: 'model.sonnet' },
  { id: 'claude-haiku-5-5', labelKey: 'model.haiku' },
];

// Free translation needs no Claude key (see offscreen/free-translator.js).
export const FREE_MODEL = 'free';

export const TRANSLATION_MODELS = [...CLAUDE_MODELS, { id: FREE_MODEL, labelKey: 'model.free' }];

export const isFreeTranslation = (settings) => settings.claudeModel === FREE_MODEL;

export const TTS_MODELS = [
  { id: 'eleven_flash_v2_5', labelKey: 'tts.flash' },
  { id: 'eleven_v4_turbo', labelKey: 'tts.v4' },
];

export const DEFAULT_SETTINGS = {
  uiLanguage: 'en', // interface language: 'en' | 'tr'

  elevenLabsKey: '',
  anthropicKey: '',
  // Optional free keys that raise the quality of free translation.
  deeplKey: '',
  mistralKey: '',
  groqKey: '',

  myLanguage: 'tr',
  theirLanguage: 'en',

  // How the counterpart reaches me: spoken translation, subtitles only (no speech
  // credits used), or off. And whether they hear my translated voice or my own.
  incomingMode: 'voice', // 'voice' | 'text' | 'off'
  outgoingMode: 'voice', // 'voice' | 'off'

  // Voice the counterpart hears when I speak (ideally my own clone).
  myVoiceId: '',
  myVoiceName: '',
  myVoiceOwnedId: '', // a clone this extension made from my recording (replaced on re-record)
  // Voice I hear for the counterpart until (or unless) their clone is ready.
  theirVoiceId: '',
  theirVoiceName: '',

  // Cloning the counterpart's voice is offered per meeting and always needs their consent.
  offerTheirClone: true,
  cloneSeconds: 45,
  deleteCloneAfter: true,

  claudeModel: 'claude-opus-5-5',
  ttsModel: 'eleven_flash_v2_5',
  meetingContext: '',
  keyterms: '',

  // Levels are linear gains (0..1).
  // The counterpart's own voice in voice mode, while nothing / a translation is speaking.
  // Silent by default: in voice mode only the translation is heard. Subtitle mode and
  // off always play their voice at full level.
  originalVolume: 0,
  duckVolume: 0,
  translationVolume: 1,
  monitorVolume: 0, // hear my own translated voice locally

  vadSilenceSecs: 0.7,
  halfDuplex: false,
  micDeviceLabel: '', // '' = same microphone as Meet, falling back to the system default
  outputDeviceLabel: '', // '' = system default output
  stability: 0.5,
  similarity: 0.8,
  showOverlay: true,
  subtitleBar: true, // the translation as subtitles low in the Meet window
  settingsVersion: 2,
};

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return migrateSettings(settings);
}

// Before version 2 voice mode kept their original voice at 0.3 (0.08 under a
// translation) by default. Settings still on those defaults move to the silent ones.
export function migrateSettings(stored) {
  const merged = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if ((stored?.settingsVersion ?? 1) < 2 && merged.originalVolume === 0.3 && merged.duckVolume === 0.08) {
    merged.originalVolume = 0;
    merged.duckVolume = 0;
  }
  return merged;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function missingKeys(settings) {
  const missing = [];
  if (!settings.elevenLabsKey) missing.push('ElevenLabs');
  if (!settings.anthropicKey && !isFreeTranslation(settings)) missing.push('Anthropic');
  return missing;
}

export function parseKeyterms(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);
}
