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
