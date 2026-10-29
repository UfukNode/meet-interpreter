// Languages offered in the settings. Every entry is supported by Scribe v2 Realtime
// (speech to text), Eleven Flash v2.5 (text to speech) and Claude (translation).
export const LANGUAGES = [
  { code: 'tr', name: 'Türkçe', english: 'Turkish' },
  { code: 'en', name: 'İngilizce', english: 'English' },
  { code: 'de', name: 'Almanca', english: 'German' },
  { code: 'fr', name: 'Fransızca', english: 'French' },
  { code: 'es', name: 'İspanyolca', english: 'Spanish' },
  { code: 'it', name: 'İtalyanca', english: 'Italian' },
  { code: 'pt', name: 'Portekizce', english: 'Portuguese' },
  { code: 'nl', name: 'Felemenkçe', english: 'Dutch' },
  { code: 'pl', name: 'Lehçe', english: 'Polish' },
  { code: 'ru', name: 'Rusça', english: 'Russian' },
  { code: 'uk', name: 'Ukraynaca', english: 'Ukrainian' },
  { code: 'ar', name: 'Arapça', english: 'Arabic' },
  { code: 'el', name: 'Yunanca', english: 'Greek' },
  { code: 'ro', name: 'Romence', english: 'Romanian' },
  { code: 'sv', name: 'İsveççe', english: 'Swedish' },
  { code: 'id', name: 'Endonezce', english: 'Indonesian' },
  { code: 'hi', name: 'Hintçe', english: 'Hindi' },
  { code: 'zh', name: 'Çince', english: 'Chinese' },
  { code: 'ja', name: 'Japonca', english: 'Japanese' },
  { code: 'ko', name: 'Korece', english: 'Korean' },
];

export function languageByCode(code) {
  return LANGUAGES.find((l) => l.code === code) || { code, name: code, english: code };
}
