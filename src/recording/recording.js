import { loadSettings } from '../shared/settings.js';
import { setLanguage, t, applyI18n, locale } from '../shared/i18n.js';
import { listRecordings, recordingBlob, deleteRecording } from '../shared/recordings.js';

const $ = (id) => document.getElementById(id);

function describe(meta, blob) {
  const date = new Date(meta.startedAt).toLocaleString(locale());
  const seconds = meta.endedAt ? Math.round((meta.endedAt - meta.startedAt) / 1000) : null;
  const duration = seconds == null ? t('rec.unfinished') : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const size = `${((blob?.size ?? meta.bytes) / 1024 / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 })} MB`;
  return `${date} · ${duration} · ${size}`;
}

function fileName(meta) {
  const d = new Date(meta.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  const ext = meta.mimeType?.includes('mp4') ? 'mp4' : 'webm';
  return `meet-interpreter-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

let objectUrl = null;

async function show(id) {
  const all = await listRecordings();
  const currentId = id || all[0]?.id;
  $('empty').hidden = all.length > 0;
  $('current').hidden = !currentId;
  if (currentId) {
    const found = await recordingBlob(currentId);
    if (found) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(found.blob);
      const player = $('player');
      player.src = objectUrl;
      // Recorded files carry no duration until the end has been seen once.
      player.addEventListener(
        'loadedmetadata',
        () => {
          if (player.duration === Infinity) {
            player.currentTime = 1e9;
            player.addEventListener('timeupdate', () => (player.currentTime = 0), { once: true });
          }
        },
        { once: true },
      );
      $('info').textContent = describe(found.meta, found.blob);
      $('download').href = objectUrl;
      $('download').download = fileName(found.meta);
      $('delete').onclick = async () => {
        if (!confirm(t('rec.deleteConfirm'))) return;
        await deleteRecording(currentId);
        history.replaceState(null, '', location.pathname);
        show(null);
      };
    }
  }
  const others = all.filter((r) => r.id !== currentId);
  $('othersBox').hidden = others.length === 0;
  $('others').replaceChildren(
    ...others.map((meta) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = describe(meta);
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = t('rec.open');
      open.addEventListener('click', () => {
        history.replaceState(null, '', `?id=${encodeURIComponent(meta.id)}`);
        show(meta.id);
      });
      li.append(label, open);
      return li;
    }),
  );
}

const settings = await loadSettings();
setLanguage(settings.uiLanguage);
applyI18n();
document.title = t('rec.title');
show(new URLSearchParams(location.search).get('id'));
