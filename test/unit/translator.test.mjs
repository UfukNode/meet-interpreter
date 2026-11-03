import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, buildSystemPrompt, buildUserMessage } from '../../src/offscreen/translator.js';

test('Opus and Sonnet requests opt into the server-side refusal fallback', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    const { beta, params } = buildRequest({ model, system: 's', user: 'u' });
    assert.equal(beta, true);
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.fallbacks, 'default');
  }
});

test('Haiku requests go without fallbacks, which it does not support', () => {
  const { beta, params } = buildRequest({ model: 'claude-haiku-5-5', system: 's', user: 'u' });
  assert.equal(beta, false);
  assert.equal(params.fallbacks, undefined);
  assert.equal(params.betas, undefined);
});

test('requests use low effort and no sampling parameters or prefill', () => {
  const { params } = buildRequest({ model: 'claude-opus-5-5', system: 's', user: 'u' });
  assert.deepEqual(params.output_config, { effort: 'low' });
  assert.equal(params.temperature, undefined);
  assert.equal(params.thinking, undefined);
  assert.equal(params.messages.at(-1).role, 'user');
});

test('Haiku and Sonnet translate without extended thinking, so the first word comes sooner', () => {
  const haiku = buildRequest({ model: 'claude-haiku-5-5', system: 's', user: 'u' }).params;
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
  assert.deepEqual(haiku.output_config, { effort: 'low' });
  const sonnet = buildRequest({ model: 'claude-sonnet-5-5', system: 's', user: 'u' }).params;
  // `between_tools` is Sonnet 5.5's lowest setting and takes no other field.
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' });
  assert.equal(sonnet.fallbacks, 'default');
});

test('the system prompt names both languages and carries the user context', () => {
  const prompt = buildSystemPrompt({
    from: 'en',
    to: 'tr',
    myLanguage: 'tr',
    theirLanguage: 'en',
    meetingContext: 'Partnership call with John.',
    keyterms: ['Fungo', 'cZAMA'],
    concise: true,
  });
  assert.match(prompt, /from English into Turkish/);
  assert.match(prompt, /Partnership call with John\./);
  assert.match(prompt, /Fungo, cZAMA/);
  assert.match(prompt, /falling behind/);
  assert.doesNotMatch(prompt, /\u2014/);
});

test('the user message keeps context apart from the utterance', () => {
  const message = buildUserMessage({
    text: 'See you on Friday.',
    from: 'en',
    to: 'tr',
    history: [
      { dir: 'out', source: 'Cuma uygun mu?', translation: 'Is Friday okay?' },
      { dir: 'in', source: 'Yes.', translation: '' },
    ],
  });
  assert.match(message, /User: Cuma uygun mu\?  \(interpreted as: Is Friday okay\?\)/);
  assert.match(message, /Counterpart: Yes\./);
  assert.match(message, /<utterance>\nSee you on Friday\.\n<\/utterance>/);
});
