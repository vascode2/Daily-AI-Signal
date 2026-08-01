/**
 * research/buzz.js — "which AI is everyone talking about right now?" analysis.
 *
 * Flow:
 *   1. Pull the newest posts from a set of AI subreddits (r/codex, r/OpenAI, ...).
 *   2. Keep only posts inside a short window (default: last 4 hours).
 *   3. Optionally pull comments for the busiest posts (reactions carry the mood).
 *   4. Count mentions of known AI models/tools, weight them by engagement,
 *      cross-subreddit spread, and recency, and score sentiment around each mention.
 *   5. Return a ranked list with the evidence needed to explain *why*.
 *
 * Everything here is deterministic and offline-testable; Gemini is only used
 * later (src/summarize.js) to write the human explanation.
 */

import * as reddit from '../collectors/reddit.js';
import { scoreAround, labelFor, describeSentiment } from './sentiment.js';

const DEFAULT_WEIGHTS = {
  title: 3,
  body: 1,
  comment: 1,
  engagement: 1.5,
  discussion: 1,
  spread: 4,
  recency: 2
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build one scanner across all entities. Aliases are sorted longest-first so
 * "claude code" wins over "claude" and "llama.cpp" wins over "llama" at the same
 * position. Lookarounds (not \b) keep "gpt-5" from matching inside "chatgpt-5"
 * and "grok" from matching "grokking".
 */
export function buildRegistry(entities = []) {
  const aliasToEntity = new Map();
  const perEntity = new Map();

  for (const e of entities) {
    const aliases = [e.name, ...(e.aliases || [])].map(a => a.toLowerCase());
    for (const a of aliases) {
      if (!aliasToEntity.has(a)) aliasToEntity.set(a, e.name);
    }
    const sorted = [...new Set(aliases)].sort((a, b) => b.length - a.length);
    perEntity.set(
      e.name,
      new RegExp(`(?<![a-z0-9])(?:${sorted.map(escapeRe).join('|')})(?![a-z0-9])`, 'gi')
    );
  }

  const allAliases = [...aliasToEntity.keys()].sort((a, b) => b.length - a.length);
  const scanner = new RegExp(
    `(?<![a-z0-9])(${allAliases.map(escapeRe).join('|')})(?![a-z0-9])`,
    'gi'
  );

  return { scanner, aliasToEntity, perEntity, entities };
}

/** Count entity mentions in a chunk of text. @returns {Map<string, number>} */
export function scanMentions(text, registry) {
  const counts = new Map();
  if (!text) return counts;
  const { scanner, aliasToEntity } = registry;
  scanner.lastIndex = 0;
  let m;
  while ((m = scanner.exec(text)) !== null) {
    const name = aliasToEntity.get(m[1].toLowerCase());
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

function mergeCounts(target, source, weight, cap) {
  for (const [name, n] of source) {
    const capped = cap > 0 ? Math.min(n, cap) : n;
    target.set(name, (target.get(name) || 0) + capped * weight);
  }
}

/** Engagement/recency multiplier applied to every mention inside a post. */
function postWeight(post, { windowStart, now, weights }) {
  const engagement = weights.engagement * Math.log10(1 + Math.max(post.score || 0, 0));
  const discussion = weights.discussion * Math.log10(1 + Math.max(post.numComments || 0, 0));
  const span = Math.max(now - windowStart, 1);
  const recencyFactor = Math.min(Math.max((post.created - windowStart) / span, 0), 1);
  const recency = weights.recency * recencyFactor;
  return 1 + engagement + discussion + recency;
}

function shortQuote(text, regex, max = 180) {
  if (!text) return '';
  const sentences = String(text).split(/(?<=[.!?\n])\s+/);
  for (const s of sentences) {
    regex.lastIndex = 0;
    const trimmed = s.trim();
    if (trimmed.length > 25 && regex.test(trimmed)) {
      return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
    }
  }
  return '';
}

/**
 * Rank AI entities by how much they are being talked about in `posts`.
 *
 * @param {Array} posts - normalized posts, optionally with a `comments` array
 * @param {object} config - parsed config/buzz.json (plus resolved window info)
 * @returns {{entities: Array, totalPosts: number, subreddits: string[], hoursBack: number}}
 */
export function analyzeBuzz(posts, config = {}) {
  const registry = config.registry || buildRegistry(config.entities || []);
  const weights = { ...DEFAULT_WEIGHTS, ...(config.weights || {}) };
  const hoursBack = config.hoursBack || 4;
  const now = config.now || Math.floor(Date.now() / 1000);
  const windowStart = config.windowStart || now - hoursBack * 3600;
  const minMentions = config.minMentions ?? 2;
  // A single post repeating "Claude" 20 times shouldn't outweigh 20 posts that
  // each mention it once, so cap what one post can contribute per field.
  const caps = { title: 2, body: 3, comment: 8, ...(config.maxMentionsPerPost || {}) };

  /** @type {Map<string, any>} */
  const stats = new Map();
  const ensure = name => {
    if (!stats.has(name)) {
      const meta = registry.entities.find(e => e.name === name) || {};
      stats.set(name, {
        name,
        vendor: meta.vendor || '',
        buzzScore: 0,
        mentions: 0,
        postCount: 0,
        commentMentions: 0,
        subreddits: new Set(),
        sentiment: { score: 0, positives: [], negatives: [] },
        evidence: [],
        quotes: []
      });
    }
    return stats.get(name);
  };

  for (const post of posts) {
    const titleCounts = scanMentions(post.title, registry);
    const bodyCounts = scanMentions(post.selftext, registry);

    const commentText = (post.comments || []).map(c => c.body).join('\n');
    const commentCounts = scanMentions(commentText, registry);

    const weighted = new Map();
    mergeCounts(weighted, titleCounts, weights.title, caps.title);
    mergeCounts(weighted, bodyCounts, weights.body, caps.body);
    mergeCounts(weighted, commentCounts, weights.comment, caps.comment);
    if (weighted.size === 0) continue;

    const pw = postWeight(post, { windowStart, now, weights });
    const postText = `${post.title}\n${post.selftext || ''}`;

    for (const [name, weightedMentions] of weighted) {
      const entity = ensure(name);
      const raw =
        Math.min(titleCounts.get(name) || 0, caps.title || Infinity) +
        Math.min(bodyCounts.get(name) || 0, caps.body || Infinity) +
        Math.min(commentCounts.get(name) || 0, caps.comment || Infinity);

      entity.buzzScore += weightedMentions * pw;
      entity.mentions += raw;
      entity.commentMentions += commentCounts.get(name) || 0;
      entity.postCount += 1;
      if (post.subreddit) entity.subreddits.add(post.subreddit);

      const mentionRe = registry.perEntity.get(name);
      const postSentiment = scoreAround(postText, mentionRe);
      const commentSentiment = scoreAround(commentText, mentionRe);
      entity.sentiment.score += postSentiment.score + commentSentiment.score;
      entity.sentiment.positives.push(...postSentiment.positives, ...commentSentiment.positives);
      entity.sentiment.negatives.push(...postSentiment.negatives, ...commentSentiment.negatives);

      entity.evidence.push({
        title: post.title,
        permalink: post.permalink,
        subreddit: post.subreddit,
        origin: post.origin || `r/${post.subreddit}`,
        score: post.score || 0,
        numComments: post.numComments || 0,
        created: post.created,
        mentions: raw,
        weight: Math.round(weightedMentions * pw * 10) / 10
      });

      const quote = shortQuote(commentText, mentionRe) || shortQuote(post.selftext, mentionRe);
      if (quote) entity.quotes.push(quote);
    }
  }

  const entities = [...stats.values()]
    .map(e => {
      const subs = [...e.subreddits];
      const spreadBonus = (weights.spread || 0) * Math.max(subs.length - 1, 0);
      const score = Math.round((e.buzzScore + spreadBonus) * 10) / 10;
      return {
        ...e,
        subreddits: subs,
        buzzScore: score,
        sentiment: {
          score: e.sentiment.score,
          label: labelFor(e.sentiment.score, e.sentiment),
          summary: describeSentiment(e.sentiment),
          positives: [...new Set(e.sentiment.positives)].slice(0, 8),
          negatives: [...new Set(e.sentiment.negatives)].slice(0, 8)
        },
        evidence: e.evidence.sort((a, b) => b.weight - a.weight).slice(0, 4),
        quotes: e.quotes.slice(0, 3)
      };
    })
    .filter(e => e.mentions >= minMentions)
    .sort((a, b) => b.buzzScore - a.buzzScore || b.mentions - a.mentions);

  return {
    entities,
    totalPosts: posts.length,
    subreddits: [...new Set(posts.map(p => p.subreddit).filter(Boolean))],
    hoursBack,
    windowStart,
    now
  };
}

/**
 * Fetch the newest posts from the configured subreddits and keep those inside the
 * window. Widens the window once if the strict window is too thin to be useful.
 */
export async function collectRecentPosts(config, { hoursBack } = {}) {
  const hours = hoursBack || config.hoursBack || 4;
  const useOAuth = reddit.hasOAuth();

  // Anonymous RSS allows roughly one request per ~30s per IP. The daily digest
  // tolerates partial coverage; buzz research does not (a single subreddit would
  // skew the ranking), so wait it out instead of stopping early.
  const rss = config.rss || {};
  const pacing = useOAuth
    ? {}
    : {
        delayMs: Number(process.env.BUZZ_RSS_DELAY_MS || rss.delayMs || 30000),
        rssRetries: rss.retries || 3,
        rssBackoffMs: rss.backoffMs || 30000,
        max429Failures: 0
      };

  const posts = await reddit.collect({
    enabled: true,
    subreddits: config.subreddits || [],
    sort: 'new',
    limitPerSubreddit: config.limitPerSubreddit || 100,
    minScore: 0,
    ...pacing
  });

  const coverage = posts.coverage || {
    covered: [...new Set(posts.map(p => p.subreddit))],
    failed: [],
    requested: (config.subreddits || []).length
  };

  const now = Math.floor(Date.now() / 1000);
  const inWindow = h => posts.filter(p => p.created && p.created >= now - h * 3600);

  let used = hours;
  let selected = inWindow(hours);
  const fallback = config.fallbackHoursBack || 0;
  const minPosts = config.minPostsForWindow ?? 0;

  if (fallback > hours && selected.length < minPosts) {
    console.log(
      `[buzz] only ${selected.length} posts in the last ${hours}h; widening to ${fallback}h.`
    );
    used = fallback;
    selected = inWindow(fallback);
  }

  console.log(`[buzz] ${selected.length} posts in the last ${used}h (of ${posts.length} fetched).`);
  return { posts: selected, hoursBack: used, fetched: posts.length, now, coverage };
}

/** Attach comments to the busiest posts (best-effort, budget-limited). */
export async function enrichWithComments(posts, config) {
  const cfg = config.comments || {};
  if (!cfg.enabled) return posts;

  // Anonymous comment feeds are throttled far harder than listing feeds, so a
  // comment pass without OAuth burns minutes and returns nothing. Skip it.
  if (!reddit.hasOAuth() && !cfg.allowWithoutOAuth) {
    console.log('[buzz] skipping comments (needs Reddit OAuth; set REDDIT_CLIENT_ID/SECRET).');
    return posts;
  }

  const topPosts = cfg.topPosts ?? 8;
  const perPost = cfg.perPost ?? 25;
  if (topPosts <= 0 || perPost <= 0) return posts;

  const ranked = [...posts]
    .sort((a, b) => (b.numComments || 0) - (a.numComments || 0) || (b.score || 0) - (a.score || 0))
    .slice(0, topPosts);

  let enriched = 0;
  for (const post of ranked) {
    const comments = await reddit.fetchComments(post.permalink, perPost);
    if (comments.length > 0) {
      post.comments = comments;
      enriched += 1;
    }
    await new Promise(r => setTimeout(r, Number(process.env.REDDIT_DELAY_MS || 1200)));
  }
  console.log(`[buzz] pulled comments for ${enriched}/${ranked.length} busiest posts.`);
  return posts;
}

/**
 * End-to-end research run: collect → enrich → analyze.
 * @param {object} config - parsed config/buzz.json
 * @param {object} [opts] - { hoursBack } override
 */
export async function runBuzz(config, opts = {}) {
  const registry = buildRegistry(config.entities || []);
  const { posts, hoursBack, fetched, now, coverage } = await collectRecentPosts(config, opts);

  if (posts.length === 0) {
    return {
      entities: [],
      totalPosts: 0,
      subreddits: [],
      hoursBack,
      fetched,
      coverage,
      top: []
    };
  }

  await enrichWithComments(posts, config);

  const analysis = analyzeBuzz(posts, {
    ...config,
    registry,
    hoursBack,
    now,
    windowStart: now - hoursBack * 3600
  });

  const topN = opts.topN || config.topN || 3;
  return {
    ...analysis,
    fetched,
    coverage,
    configuredSubreddits: config.subreddits || [],
    top: analysis.entities.slice(0, topN)
  };
}
