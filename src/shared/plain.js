// Chrome's own translator, the free step that needs no key, takes everyday meeting talk
// word for word: "Let's touch base on Monday" came out as "Pazartesi günü üsse
// dokunalım", "Sesim geliyor mu?" as "Is my voice coming?". Before it translates, such
// phrases are put in plainer words of the same language, which it gets right ("Let's
// talk briefly on Monday" -> "Pazartesi günü kısaca konuşalım"). Each rewrite below was
// checked through Chrome 156's translator on 4 November 2026. The other free services and
// Claude understand idioms, so they get the speaker's own words.

// A phrase matches only as whole words (Turkish letters count as letters).
function phrase(source) {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'giu');
}

const REWRITES = {
  en: [
    [phrase('does (that|this|it) work for'), 'is $1 okay for'],
    [phrase('(that|this|it) works for (me|us)'), '$1 is okay for $2'],
    [phrase('(that|this|it) would work for (me|us|you)'), '$1 would be okay for $2'],
    [phrase('sounds good to me'), 'I agree'],
    [phrase('(?:that )?sounds (?:good|great)'), 'okay, good'],
    [phrase('get back to (you|me|us|them|him|her)'), 'reply to $1'],
    [phrase('circle back (?:to|on)'), 'return to'],
    [phrase('touch base'), 'talk briefly'],
    [phrase('reach out to'), 'contact'],
    [phrase('reach out'), 'contact us'],
    [phrase('on the same page'), 'in agreement'],
    [phrase('heads[- ]up'), 'note'],
    [phrase('wrap (?:it |things |this )?up'), 'finish'],
    [phrase('follow up (with|on)'), 'check again $1'],
    [phrase("(?:i'?m|i am) not sure i follow"), "I'm not sure I understand"],
    [phrase("i don'?t follow"), "I don't understand"],
    [phrase('walk (me|us|you) through (it|this|that)'), 'explain $2 to $1 step by step'],
    [phrase('walk (me|us|you) through'), 'explain to $1 step by step'],
    [phrase('fair enough'), "that's reasonable"],
    [phrase("you'?re (still )?on mute"), 'your microphone is $1off'],
    [phrase('take (this|it|that) offline'), 'talk about $1 separately'],
    [phrase('push (?:back )?the deadline'), 'postpone the deadline'],
    [phrase('thanks? (?:you )?for having (me|us)'), 'thank you for inviting $1'],
    [phrase('have a good one'), 'have a good day'],
    [phrase("we'?re running out of time"), "we're almost out of time"],
    [phrase('no worries'), 'no problem'],
    [phrase('my bad'), 'my mistake'],
    [phrase('(?:hang|hold) on a (?:sec|second)'), 'wait a moment'],
    [phrase('deep[- ]dive'), 'detailed look'],
    [phrase('ballpark(?: figure)?'), 'rough estimate'],
    [phrase("let'?s sync"), "let's talk"],
    [phrase('ping (me|us|him|her|them)'), 'message $1'],
    [phrase('timeline'), 'schedule'],
    // In meetings "the numbers" are figures, not phone numbers.
    [phrase('(?<!phone |account |order |serial )(the|new|latest|final|updated|sales|revenue|budget|financial|quarterly|monthly) numbers'), '$1 figures'],
  ],
  tr: [
    [phrase('kolay gelsin'), 'umarım işler iyi gidiyordur'],
    [phrase('ellerin(?:iz)?e sağlık'), 'çok teşekkürler'],
    [phrase('emeğin(?:iz)?e sağlık'), 'emeğiniz için teşekkürler'],
    [phrase('estağfurullah'), 'hiç sorun değil'],
    [phrase('hayırlı olsun'), 'tebrikler'],
    [phrase('sesim (?:geliyor|gidiyor) mu'), 'beni duyabiliyor musunuz'],
    [phrase('sesiniz gelmiyor'), 'sizi duyamıyorum'],
    [phrase('sesin gelmiyor'), 'seni duyamıyorum'],
    [phrase('toparlarsak'), 'özetlersek'],
  ],
};

// Keeps a capital first letter where the speaker's sentence had one.
function keepCase(original, replacement) {
  const first = original.match(/\p{L}/u)?.[0];
  if (!first || first === first.toLocaleLowerCase()) return replacement;
  return replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1);
}

// The special terms from the settings, spelled exactly as given: Chrome's translator keeps
// names but changes their case ("cZAMA" came back as "CZAMA", "launchpad" as "Launchpad").
export function keepTerms(text, terms = []) {
  let out = String(text);
  for (const term of terms) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(phrase(escaped), term);
  }
  return out;
}

export function plainForMachine(text, language) {
  const rules = REWRITES[String(language || '').slice(0, 2)];
  if (!rules) return text;
  let out = String(text);
  for (const [pattern, replacement] of rules) {
    out = out.replace(pattern, (...match) => {
      const groups = match.slice(1, -2);
      const filled = replacement.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? '');
      return keepCase(match[0], filled);
    });
  }
  return out;
}
