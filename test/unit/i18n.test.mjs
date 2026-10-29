import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRINGS_FOR_TESTS as STRINGS, setLanguage, getLanguage, t, languageLabel, joinNames, locale } from '../../src/shared/i18n.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';

test('the interface starts in English', () => {
  assert.equal(DEFAULT_SETTINGS.uiLanguage, 'en');
  assert.equal(getLanguage(), 'en');
});

test('English and Turkish have exactly the same keys', () => {
  const en = Object.keys(STRINGS.en).sort();
  const tr = Object.keys(STRINGS.tr).sort();
  assert.deepEqual(tr.filter((k) => !STRINGS.en[k]), []);
  assert.deepEqual(en.filter((k) => !STRINGS.tr[k]), []);
});

test('placeholders match between the languages', () => {
  const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of Object.keys(STRINGS.en)) assert.equal(names(STRINGS.tr[key]), names(STRINGS.en[key]), key);
});

test('no em dashes in any interface text', () => {
  for (const lang of Object.keys(STRINGS)) {
    for (const [key, text] of Object.entries(STRINGS[lang])) assert.doesNotMatch(text, /—/, `${lang} ${key}`);
  }
});

test('switching languages changes texts, names and number formats', () => {
  setLanguage('tr');
  assert.equal(t('popup.start'), 'Çeviriyi başlat');
  assert.equal(languageLabel('en'), 'İngilizce');
  assert.equal(joinNames(['ElevenLabs', 'Anthropic']), 'ElevenLabs ve Anthropic');
  assert.equal(locale(), 'tr-TR');
  setLanguage('en');
  assert.equal(t('popup.start'), 'Start translation');
  assert.equal(languageLabel('tr'), 'Turkish');
  assert.equal(t('err.keysMissing', { names: joinNames(['ElevenLabs', 'Anthropic']) }), 'ElevenLabs and Anthropic API key missing. Add it in the extension settings.');
  assert.equal(setLanguage('xx'), 'en');
});

test('an unknown key falls back to the key itself', () => {
  assert.equal(t('does.not.exist'), 'does.not.exist');
});
