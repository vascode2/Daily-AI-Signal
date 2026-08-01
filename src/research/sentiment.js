/**
 * research/sentiment.js — lightweight, deterministic sentiment scoring tuned to
 * how people actually talk about AI models on Reddit.
 *
 * Deliberately not an LLM call: the buzz analysis must be cheap, offline-testable,
 * and stable across runs. Gemini is used later only to explain *why* something is
 * being discussed, not to compute the numbers.
 *
 * Usage:
 *   scoreText('opus got nerfed again')  -> { score: -2, positives: [], negatives: ['nerfed'] }
 *   labelFor(-2)                        -> 'mixed'
 */

/** Positive cues, including AI/dev slang. Weight 2 = strong. */
const POSITIVE = {
  amazing: 2, awesome: 2, excellent: 2, fantastic: 2, incredible: 2, insane: 2,
  goat: 2, cracked: 2, 'blown away': 2, 'game changer': 2, 'game-changer': 2,
  'best model': 2, 'so good': 2, 'love it': 2, crushing: 2, impressive: 2,
  impressed: 2, great: 1, good: 1, solid: 1, nice: 1, clean: 1, reliable: 1,
  useful: 1, helpful: 1, 'works well': 2, smooth: 1, fast: 1, cheap: 1,
  'worth it': 2, recommend: 1, upgrade: 1, improved: 1, improvement: 1,
  better: 1, beats: 1, wins: 1, 'one shot': 1, 'one-shot': 1, 'nailed it': 2,
  finally: 1, underrated: 1, breakthrough: 2, love: 1, favorite: 1,
  powerful: 1, accurate: 1, 'no issues': 2, 'happy with': 2
};

/** Negative cues, including the usual model-regression complaints. */
const NEGATIVE = {
  nerfed: 2, nerf: 2, lobotomized: 2, 'dumbed down': 2, downgrade: 2, worse: 2,
  broken: 2, garbage: 2, trash: 2, useless: 2, terrible: 2, awful: 2, horrible: 2,
  disappointing: 2, disappointed: 2, frustrating: 2, frustrated: 2, unusable: 2,
  scam: 2, ripoff: 2, 'rip off': 2, overpriced: 2, 'waste of money': 2,
  'rate limit': 2, 'rate limits': 2, 'rate-limited': 2, 'usage limit': 2,
  'usage limits': 2, 'hit the limit': 2, throttled: 2, capped: 1, quota: 1,
  hallucinate: 2, hallucinating: 2, hallucination: 2, hallucinations: 2,
  'ignores instructions': 2, 'ignoring instructions': 2, 'context rot': 2,
  regression: 2, buggy: 2, bug: 1, bugs: 1, crash: 2, crashes: 2, crashing: 2,
  slow: 1, laggy: 1, expensive: 1, pricey: 1, annoying: 1, cancelled: 2,
  canceling: 1, cancelling: 1, 'cancel my': 2, 'switched away': 2, 'moving off': 2,
  refuses: 2, refused: 2, refusal: 2, censored: 1, 'safety theater': 2,
  overhyped: 2, hype: 1, mid: 1, meh: 1, struggles: 1, struggling: 1,
  failed: 1, fails: 1, failing: 1, error: 1, errors: 1, 'not worth': 2,
  'stopped working': 2, 'went downhill': 2
};

const NEGATORS = ['not', 'no', 'never', 'barely', 'hardly', 'stop', 'stopped'];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildLexiconRegex(lexicon) {
  const terms = Object.keys(lexicon)
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  return new RegExp(`(?<![a-z0-9])(${terms.join('|')})(?![a-z0-9])`, 'gi');
}

const POSITIVE_RE = buildLexiconRegex(POSITIVE);
const NEGATIVE_RE = buildLexiconRegex(NEGATIVE);

/** True when a negator appears in the ~4 words before `index`. */
function isNegated(text, index) {
  const before = text.slice(Math.max(0, index - 40), index).toLowerCase();
  if (/n['’]t\s+\S*\s*$/.test(before)) return true;
  const words = before.split(/[^a-z']+/).filter(Boolean).slice(-4);
  return words.some(w => NEGATORS.includes(w));
}

function collect(text, regex, lexicon) {
  const hits = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const term = m[1].toLowerCase();
    hits.push({ term, weight: lexicon[term] || 1, negated: isNegated(text, m.index) });
  }
  return hits;
}

/**
 * Score a chunk of text.
 * Negated positives count as negative and vice versa ("not worth it", "no bugs").
 * @returns {{score:number, positives:string[], negatives:string[]}}
 */
export function scoreText(text) {
  if (!text) return { score: 0, positives: [], negatives: [] };
  const t = String(text);

  const positives = [];
  const negatives = [];
  let score = 0;

  for (const hit of collect(t, POSITIVE_RE, POSITIVE)) {
    if (hit.negated) {
      score -= hit.weight;
      negatives.push(`not ${hit.term}`);
    } else {
      score += hit.weight;
      positives.push(hit.term);
    }
  }
  for (const hit of collect(t, NEGATIVE_RE, NEGATIVE)) {
    if (hit.negated) {
      score += hit.weight;
      positives.push(`not ${hit.term}`);
    } else {
      score -= hit.weight;
      negatives.push(hit.term);
    }
  }

  return { score, positives, negatives };
}

/**
 * Score only the sentences that actually mention the entity, so a post that
 * praises one model while trashing another attributes each mood correctly.
 * @param {string} text
 * @param {RegExp} mentionRegex - global regex matching the entity's aliases
 */
export function scoreAround(text, mentionRegex) {
  if (!text) return { score: 0, positives: [], negatives: [] };
  const sentences = String(text).split(/(?<=[.!?\n])\s+/);
  const relevant = sentences.filter(s => {
    mentionRegex.lastIndex = 0;
    return mentionRegex.test(s);
  });
  if (relevant.length === 0) return { score: 0, positives: [], negatives: [] };

  const merged = { score: 0, positives: [], negatives: [] };
  for (const s of relevant) {
    const r = scoreText(s);
    merged.score += r.score;
    merged.positives.push(...r.positives);
    merged.negatives.push(...r.negatives);
  }
  return merged;
}

/**
 * Map a raw sentiment score to a coarse label. When both praise and complaints are
 * present but roughly cancel out, that is "divided" — meaningfully different from a
 * post nobody had an opinion about ("neutral").
 */
export function labelFor(score, counts) {
  const pos = counts?.positives?.length || 0;
  const neg = counts?.negatives?.length || 0;
  if (pos > 0 && neg > 0 && Math.abs(score) < 3) return 'divided';
  if (score >= 3) return 'positive';
  if (score <= -3) return 'negative';
  if (score === 0) return 'neutral';
  return 'mixed';
}

/** Human-readable mood string, e.g. "mostly positive (+7)". */
export function describeSentiment({ score = 0, positives = [], negatives = [] } = {}) {
  const label = labelFor(score, { positives, negatives });
  const prefix = {
    positive: 'mostly positive',
    negative: 'mostly negative',
    divided: 'divided',
    mixed: 'mixed',
    neutral: 'neutral'
  }[label];
  const sign = score > 0 ? `+${score}` : String(score);
  const total = positives.length + negatives.length;
  return total > 0 ? `${prefix} (${sign})` : prefix;
}
