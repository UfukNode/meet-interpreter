import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Usage, formatUsage } from '../../src/shared/usage.js';
import { setLanguage } from '../../src/shared/i18n.js';

test('usage turns into an estimate from list prices', () => {
  const usage = new Usage();
  usage.addStt(3600); // one hour of one direction
  usage.addTts(10000, 'eleven_flash_v2_5');
  usage.addClaude('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 });
  const snap = usage.snapshot();
  assert.equal(snap.ttsChars, 10000);
  assert.equal(snap.claudeTokens, 1_100_000);
  assert.ok(Math.abs(snap.usd - (0.39 + 0.4 + 0.1 + 0.05)) < 1e-9);
  setLanguage('en');
  assert.equal(formatUsage(snap), ['60.0 min listening', '10,000 characters of speech', '1,100.0k tokens', 'about $0.94'].map((x) => x.replace(/ /g, '\u00a0')).join(' · '));
  setLanguage('tr');
  assert.match(formatUsage(snap), /60,0\u00a0dk\u00a0dinleme/);
  assert.match(formatUsage(snap), /1\.100,0\u00a0bin\u00a0token/);
  assert.match(formatUsage(snap), /yaklaşık\u00a00,94\u00a0\$/);
  setLanguage('en');
});
