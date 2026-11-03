import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainForMachine, keepTerms } from '../../src/shared/plain.js';

test('everyday English meeting phrases are put in plainer words', () => {
  const cases = [
    ['Does that work for you?', 'Is that okay for you?'],
    ['Friday at three, does that work for your team?', 'Friday at three, is that okay for your team?'],
    ['That works for me.', 'That is okay for me.'],
    ['Sounds good.', 'Okay, good.'],
    ['Sounds good to me, thanks.', 'I agree, thanks.'],
    ["Let's touch base on Monday.", "Let's talk briefly on Monday."],
    ["Let's wrap up here.", "Let's finish here."],
    ['Could you walk me through it?', 'Could you explain it to me step by step?'],
    ["You're on mute.", 'Your microphone is off.'],
    ["You're still on mute.", 'Your microphone is still off.'],
    ['Thanks for having me.', 'Thank you for inviting me.'],
    ['Have a good one.', 'Have a good day.'],
    ['Please send the new numbers to the team.', 'Please send the new figures to the team.'],
    ["I'll reach out to the vendor.", "I'll contact the vendor."],
    ['Feel free to reach out.', 'Feel free to contact us.'],
  ];
  for (const [said, plain] of cases) assert.equal(plainForMachine(said, 'en'), plain);
});

test('Turkish courtesy phrases are put in words Chrome translates right', () => {
  assert.equal(plainForMachine('Kolay gelsin.', 'tr'), 'Umarım işler iyi gidiyordur.');
  assert.equal(plainForMachine('Sesim geliyor mu?', 'tr'), 'Beni duyabiliyor musunuz?');
  assert.equal(plainForMachine('Ellerinize sağlık, çok güzel olmuş.', 'tr'), 'Çok teşekkürler, çok güzel olmuş.');
  assert.equal(plainForMachine('Toparlarsak, cuma günü teslim ediyoruz.', 'tr'), 'Özetlersek, cuma günü teslim ediyoruz.');
});

test('only whole phrases change, and other languages are left alone', () => {
  assert.equal(plainForMachine('Call me at the phone numbers I sent.', 'en'), 'Call me at the phone numbers I sent.');
  assert.equal(plainForMachine('The homework for me is done.', 'en'), 'The homework for me is done.');
  assert.equal(plainForMachine('Sounds good.', 'de'), 'Sounds good.');
  assert.equal(plainForMachine('Merhaba, nasılsınız?', 'tr'), 'Merhaba, nasılsınız?');
});

test('special terms come back spelled exactly as in the settings', () => {
  assert.equal(keepTerms('Fungo Launchpad ekibine CZAMA fiyatını sorun.', ['Fungo', 'cZAMA', 'launchpad']), 'Fungo launchpad ekibine cZAMA fiyatını sorun.');
  assert.equal(keepTerms('The launchpads are ready.', ['launchpad']), 'The launchpads are ready.');
  assert.equal(keepTerms('No terms here.', []), 'No terms here.');
});
