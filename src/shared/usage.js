import { t, locale } from './i18n.js';

// Live usage counter for one session, so the user can see what a call consumes.
// The dollar figure is an estimate: measured usage multiplied by list prices, which
// were taken from elevenlabs.io/pricing/api and Anthropic's model table on
// 28 October 2026. A subscription plan may bill the same usage differently.
export const LIST_PRICES = {
  sttRealtimePerHour: 0.39,
  ttsPer1kChars: { eleven_flash_v2_5: 0.04, eleven_v4_turbo: 0.04 },
  claudePerMTok: {
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  },
};

export class Usage {
  constructor() {
    this.sttSeconds = 0;
    this.ttsChars = {};
    this.claude = {};
  }

  addStt(seconds) {
    this.sttSeconds += seconds;
  }

  addTts(chars, model) {
    this.ttsChars[model] = (this.ttsChars[model] || 0) + chars;
  }

  addClaude(model, usage) {
    const entry = (this.claude[model] ||= { input: 0, output: 0 });
    entry.input += (usage?.input_tokens || 0) + (usage?.cache_read_input_tokens || 0) + (usage?.cache_creation_input_tokens || 0);
    entry.output += usage?.output_tokens || 0;
  }

  costUsd() {
    let usd = (this.sttSeconds / 3600) * LIST_PRICES.sttRealtimePerHour;
    for (const [model, chars] of Object.entries(this.ttsChars)) {
      usd += (chars / 1000) * (LIST_PRICES.ttsPer1kChars[model] ?? 0.04);
    }
    for (const [model, t] of Object.entries(this.claude)) {
      const price = LIST_PRICES.claudePerMTok[model];
      if (price) usd += (t.input / 1e6) * price.input + (t.output / 1e6) * price.output;
    }
    return usd;
  }

  snapshot() {
    const ttsChars = Object.values(this.ttsChars).reduce((a, b) => a + b, 0);
    const tokens = Object.values(this.claude).reduce((a, t) => a + t.input + t.output, 0);
    return {
      sttMinutes: this.sttSeconds / 60,
      ttsChars,
      claudeTokens: tokens,
      usd: this.costUsd(),
    };
  }
}

export const formatNumber = (n, digits = 0) =>
  Number(n || 0).toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });

// Non-breaking spaces keep each number with its unit when the line wraps.
export function formatUsage(usage) {
  if (!usage) return '';
  const keep = (text) => text.replace(/ /g, '\u00a0');
  const tokens =
    usage.claudeTokens >= 1000
      ? t('usage.tokensK', { n: formatNumber(usage.claudeTokens / 1000, 1) })
      : t('usage.tokens', { n: formatNumber(usage.claudeTokens) });
  // Free translation uses no Claude tokens, so the token count is left out.
  return [
    t('usage.listening', { n: formatNumber(usage.sttMinutes, 1) }),
    t('usage.speech', { n: formatNumber(usage.ttsChars) }),
    usage.claudeTokens ? tokens : '',
    t('usage.cost', { n: formatNumber(usage.usd, 2) }),
  ]
    .filter(Boolean)
    .map(keep)
    .join(' · ');
}
