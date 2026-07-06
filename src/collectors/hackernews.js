/**
 * collectors/hackernews.js — Hacker News source collector.
 *
 * Uses the official HN Firebase API (no auth, no app):
 *   https://hacker-news.firebaseio.com/v0/
 *
 * Flow:
 *  1) pull `topstories` ids
 *  2) fetch item details
 *  3) keep only recent stories above a points threshold
 *
 * Topic filtering still happens later in filter.js.
 */

const SOURCE = 'hackernews';
const API = 'https://hacker-news.firebaseio.com/v0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchItems(ids, { batchSize = 20, delayMs = 200 }) {
  const out = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const rows = await Promise.all(
      batch.map(async id => {
        try {
          return await getJson(`${API}/item/${id}.json`);
        } catch {
          return null;
        }
      })
    );
    out.push(...rows.filter(Boolean));
    await sleep(delayMs);
  }
  return out;
}

/**
 * @param {object} config - the `hackernews` section of config/sources.json
 * @returns {Promise<Array>} normalized posts
 */
export async function collect(config) {
  if (!config?.enabled) {
    console.log(`[${SOURCE}] disabled in config; skipping.`);
    return [];
  }

  const {
    hoursBack = 48,
    minPoints = 30,
    limit = 100,
    candidatePool = 300
  } = config;

  const now = Math.floor(Date.now() / 1000);
  const since = now - hoursBack * 3600;

  try {
    const topIds = await getJson(`${API}/topstories.json`);
    const ids = (topIds || []).slice(0, candidatePool);
    const items = await fetchItems(ids, { batchSize: 20, delayMs: 120 });

    const posts = items
      .filter(it => it?.type === 'story' && it.title && it.time >= since && (it.score || 0) >= minPoints)
      .slice(0, limit)
      .map(it => {
        const permalink = `https://news.ycombinator.com/item?id=${it.id}`;
        return {
          source: SOURCE,
          id: `${SOURCE}:${it.id}`,
          title: String(it.title).trim(),
          url: it.url || permalink,
          permalink,
          score: it.score || 0,
          numComments: it.descendants || 0,
          subreddit: 'HackerNews',
          origin: 'Hacker News',
          author: it.by || 'unknown',
          selftext: '',
          created: it.time || 0
        };
      });

    console.log(
      `[${SOURCE}] collected ${posts.length} stories (top ${candidatePool}, last ${hoursBack}h, >= ${minPoints} pts).`
    );
    return posts;
  } catch (err) {
    console.error(`[${SOURCE}] failed: ${err.message}`);
    return [];
  }
}

export const source = SOURCE;
