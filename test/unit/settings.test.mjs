import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings, DEFAULT_SETTINGS } from '../../src/shared/settings.js';

test('voice mode is silent for their own voice by default, and old defaults move along', () => {
  assert.equal(DEFAULT_SETTINGS.originalVolume, 0);
  assert.equal(DEFAULT_SETTINGS.duckVolume, 0);
  const old = migrateSettings({ originalVolume: 0.3, duckVolume: 0.08, uiLanguage: 'tr' });
  assert.equal(old.originalVolume, 0);
  assert.equal(old.duckVolume, 0);
  assert.equal(old.uiLanguage, 'tr');
  const chosen = migrateSettings({ originalVolume: 0.5, duckVolume: 0.1 });
  assert.equal(chosen.originalVolume, 0.5);
  const again = migrateSettings({ originalVolume: 0.3, duckVolume: 0.08, settingsVersion: 2 });
  assert.equal(again.originalVolume, 0.3);
  assert.equal(migrateSettings(undefined).subtitleBar, true);
});

test('the voice model moves from Flash v2.5 to v4 Turbo once, and a later choice stays', () => {
  assert.equal(DEFAULT_SETTINGS.ttsModel, 'eleven_v4_turbo');
  assert.equal(migrateSettings({ ttsModel: 'eleven_flash_v2_5', settingsVersion: 2 }).ttsModel, 'eleven_v4_turbo');
  assert.equal(migrateSettings({ ttsModel: 'eleven_flash_v2_5' }).ttsModel, 'eleven_v4_turbo');
  assert.equal(migrateSettings({ ttsModel: 'eleven_flash_v2_5', settingsVersion: 3 }).ttsModel, 'eleven_flash_v2_5');
  // Saving the migrated settings records the version, so the move happens only once.
  assert.equal(migrateSettings({ settingsVersion: 2 }).settingsVersion, 3);
});

test('subtitles show only the translation unless the original is asked for', () => {
  assert.equal(migrateSettings(undefined).subtitleOriginal, false);
  assert.equal(migrateSettings({ subtitleOriginal: true }).subtitleOriginal, true);
});
