// Live check of the free translation services with the extension's own FreeTranslator.
// Uses whichever of DEEPL_API_KEY, MISTRAL_API_KEY and GROQ_API_KEY are in .env, tests
// each service on its own (key check, then the same meeting sentences both ways) and
// prints the translations with their timings. Chrome's built-in translator, the keyless
// last step, needs a browser and is not part of this script.
//
//   node test/api/free.mjs

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FreeTranslator, FREE_STEPS, checkFreeKey } from '../../src/offscreen/free-translator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function env() {
  const vars = { ...process.env };
  const file = path.join(root, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[2]) vars[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return vars;
}

const vars = env();
const keys = { deeplKey: vars.DEEPL_API_KEY || '', mistralKey: vars.MISTRAL_API_KEY || '', groqKey: vars.GROQ_API_KEY || '' };
if (!Object.values(keys).some(Boolean)) {
  console.error('Put at least one of DEEPL_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY in .env.');
  process.exit(1);
}

const SENTENCES = {
  'en>tr': [
    'Hi, thanks for joining the call today.',
    'I wanted to talk about the launch timeline.',
    'We are planning to open the public sale next Friday at 3:00 in the afternoon.',
    'Does that work for your team?',
    'Could you send me the contract by the end of the week?',
    'Honestly, I think the price is a bit too high for us.',
  ],
  'tr>en': [
    'Merhaba, davet için teşekkürler.',
    'Cuma günü saat üç bizim için uygun.',
    'Ekibimle konuşup size e-posta ile dönüş yapacağım.',
    'Fiyat konusunda biraz esneklik olabilir mi?',
    'Sözleşmeyi bu hafta içinde göndermeye çalışırım.',
  ],
};

let failures = 0;

for (const step of FREE_STEPS.filter((s) => s.key)) {
  if (!keys[step.key]) {
    console.log(`\n== ${step.id}: skipped (no ${step.key.replace('Key', '').toUpperCase()} key in .env)`);
    continue;
  }
  console.log(`\n== ${step.id}${step.model ? ` (${step.model})` : ''}`);
  const check = await checkFreeKey(step.key, keys[step.key]);
  console.log(`   key check: ${check.ok ? 'ok' : 'FAILED'}, ${check.message}`);
  if (!check.ok) {
    failures += 1;
    continue;
  }
  const logs = [];
  const translator = new FreeTranslator({
    keys: { [step.key]: keys[step.key] },
    myLanguage: 'tr',
    theirLanguage: 'en',
    meetingContext: 'A business call about a product launch.',
    local: null,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  // Force this step: everything before it with the same key rests.
  for (const other of FREE_STEPS) if (other !== step) translator.restUntil.set(other.id, Infinity);
  const history = [];
  for (const [pair, list] of Object.entries(SENTENCES)) {
    const [from, to] = pair.split('>');
    for (const text of list) {
      const started = performance.now();
      let translation;
      try {
        const pieces = [];
        for await (const piece of translator.translate({ text, from, to, history: history.slice(-6) })) pieces.push(piece);
        translation = pieces.join(' ');
        history.push({ dir: from === 'en' ? 'in' : 'out', source: text, translation });
      } catch (err) {
        failures += 1;
        translation = `ERROR ${err.message} | ${logs.at(-1) || ''}`;
      }
      console.log(`   ${pair} ${String(Math.round(performance.now() - started)).padStart(5)} ms  ${text}\n${' '.repeat(18)}-> ${translation}`);
    }
  }
}

console.log(failures ? `\n${failures} problem(s)` : '\nall free services that had a key worked');
process.exit(failures ? 1 : 0);
