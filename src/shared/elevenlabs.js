import { t } from './i18n.js';

// Thin client for the ElevenLabs REST endpoints the extension uses. Extension pages
// hold host permission for api.elevenlabs.io, so the API key travels in a header
// straight from this browser to ElevenLabs and nowhere else.

export const ELEVENLABS_API = 'https://api.elevenlabs.io';

export class ElevenLabsError extends Error {
  constructor(status, body) {
    let code = '';
    let detail = '';
    try {
      const parsed = JSON.parse(body);
      const d = parsed.detail ?? parsed;
      if (typeof d === 'string') detail = d;
      else if (Array.isArray(d)) detail = d.map((x) => x.msg).join('; ');
      else {
        code = d.status || d.code || '';
        detail = d.message || '';
      }
    } catch {
      detail = String(body || '').slice(0, 300);
    }
    super(`ElevenLabs ${status}${code ? ` ${code}` : ''}: ${detail}`);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  get retryable() {
    if (this.code === 'quota_exceeded') return false;
    return this.status === 429 || this.status >= 500;
  }
}

// fetch rejects with a TypeError when the connection fails ("Failed to fetch"); an
// abort is a DOMException instead.
export function isNetworkError(err) {
  return err?.name === 'TypeError';
}

async function request(apiKey, path, init = {}) {
  const res = await fetch(ELEVENLABS_API + path, {
    ...init,
    headers: { 'xi-api-key': apiKey, ...(init.headers || {}) },
  });
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // body unavailable
    }
    throw new ElevenLabsError(res.status, body);
  }
  return res;
}

export async function fetchScribeToken(apiKey) {
  const res = await request(apiKey, '/v1/single-use-token/realtime_scribe', { method: 'POST' });
  const { token } = await res.json();
  return token;
}

export async function listVoices(apiKey) {
  const res = await request(apiKey, '/v1/voices');
  const json = await res.json();
  return json.voices || [];
}

export async function createVoiceClone(apiKey, { name, files, description }) {
  const form = new FormData();
  form.append('name', name);
  for (const file of files) form.append('files', file.blob, file.filename);
  if (description) form.append('description', description);
  const res = await request(apiKey, '/v1/voices/add', { method: 'POST', body: form });
  return res.json();
}

export async function deleteVoice(apiKey, voiceId) {
  await request(apiKey, `/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE' });
}

// Starts a streamed text to speech request. The response body is raw 16-bit mono PCM.
export async function speechStream(
  apiKey,
  { voiceId, text, modelId, languageCode, voiceSettings, previousText, sampleRate = 24000, signal },
) {
  const body = { text, model_id: modelId };
  if (languageCode) body.language_code = languageCode;
  if (voiceSettings) body.voice_settings = voiceSettings;
  if (previousText) body.previous_text = previousText;
  return request(apiKey, `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_${sampleRate}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

export function describeElevenLabsError(err) {
  if (isNetworkError(err)) return t('el.network');
  if (!(err instanceof ElevenLabsError)) return err?.message || String(err);
  if (err.status === 401) {
    if (err.code === 'quota_exceeded') return t('el.quota');
    if (err.code === 'missing_permissions') return t('el.permissions');
    return t('el.invalid');
  }
  if (err.status === 402) return t('el.paid');
  if (err.status === 403) return t('el.forbidden');
  if (err.status === 404) return t('el.voiceMissing');
  if (err.code === 'quota_exceeded') return t('stt.quota');
  if (err.status === 429) return t('el.busy');
  if (err.status >= 500) return t('el.down');
  return err.message;
}
