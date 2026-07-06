/**
 * filter.js — relevance filtering, ranking, and topic grouping.
 *
 * Keeps the MVP simple and deterministic (no LLM needed here):
 *   1. Match each post to topics via keyword lookup.
 *   2. Drop posts that match no topic (noise).
 *   3. Score usefulness/novelty/practical value with a lightweight heuristic.
 *   4. Group by topic and keep the top N per topic.
 *
 * The relevance step can later be upgraded to an LLM classifier without
 * changing the interface: `filterAndGroup(posts, topicsConfig) -> grouped`.
 */

/** Words that hint at practical, hands-on value. */
const PRACTICAL_HINTS = [
  'how to', 'guide', 'tutorial', 'built', 'i made', 'i built', 'open source',
  'open-source', 'released', 'benchmark', 'comparison', 'workflow', 'setup',
  'tip', 'lesson', 'demo', 'example', 'template', 'free'
];

/** Words that usually signal low-signal / noise for an engineering audience. */
const NOISE_HINTS = [
  'meme', 'shitpost', 'lol', 'rant', 'drama', 'clickbait', 'hot take',
  'unpopular opinion', 'poll', 'meta'
];

function matchTopics(post, topics) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();
  const matched = [];
  for (const topic of topics) {
    if (topic.keywords.some(kw => text.includes(kw.toLowerCase()))) {
      matched.push(topic.name);
    }
  }
  return matched;
}

/**
 * Heuristic usefulness score combining engagement, discussion depth,
 * practical signal, and a noise penalty. Higher is better.
 */
function usefulnessScore(post) {
  const text = `${post.title} ${post.selftext}`.toLowerCase();

  const engagement = Math.log10(Math.max(post.score, 1)) * 10;
  const discussion = Math.log10(Math.max(post.numComments, 1)) * 6;
  const hasBody = post.selftext.length > 200 ? 4 : 0;

  const practical = PRACTICAL_HINTS.reduce(
    (acc, hint) => (text.includes(hint) ? acc + 3 : acc),
    0
  );
  const noise = NOISE_HINTS.reduce(
    (acc, hint) => (text.includes(hint) ? acc - 6 : acc),
    0
  );

  return Math.round(engagement + discussion + hasBody + practical + noise);
}

/**
 * @param {Array} posts - normalized posts from collectors
 * @param {object} topicsConfig - parsed config/topics.json
 * @returns {Array<{topic: string, posts: Array}>} groups ordered by topic config
 */
export function filterAndGroup(posts, topicsConfig) {
  const topics = topicsConfig.topics || [];
  const maxPerTopic = topicsConfig.maxPostsPerTopic || 5;

  // Attach topic matches + score; drop non-matching (noise) posts.
  const enriched = [];
  for (const post of posts) {
    const matched = matchTopics(post, topics);
    if (matched.length === 0) continue;
    enriched.push({
      ...post,
      topics: matched,
      usefulness: usefulnessScore(post)
    });
  }

  // Group by topic, preserving the order topics appear in config.
  const groups = [];
  const usedIds = new Set();
  for (const topic of topics) {
    const inTopic = enriched
      .filter(p => p.topics.includes(topic.name))
      .sort((a, b) => b.usefulness - a.usefulness);

    // Prefer to show each post under a single (best) topic to reduce repeats.
    const picked = [];
    for (const p of inTopic) {
      if (usedIds.has(p.id)) continue;
      picked.push(p);
      usedIds.add(p.id);
      if (picked.length >= maxPerTopic) break;
    }

    if (picked.length > 0) {
      groups.push({ topic: topic.name, posts: picked });
    }
  }

  const total = groups.reduce((n, g) => n + g.posts.length, 0);
  console.log(`[filter] kept ${total} posts across ${groups.length} topics.`);
  return groups;
}
