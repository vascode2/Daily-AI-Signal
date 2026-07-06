/**
 * collectors/reddit.js — Reddit source collector.
 *
 * Every collector exports an async `collect(config)` that returns a normalized
 * array of post objects. New sources (X, GitHub, RSS, ...) implement the same
 * contract and shape, so `src/index.js` treats them uniformly.
 *
 * Two access modes (Reddit blocks anonymous JSON, so we adapt):
 *   1. OAuth  — used when REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET are set.
 *               Reliable, includes score / comment counts / selftext.
 *   2. RSS    — no credentials needed (public Atom feed). Limited: no score or
 *               comment counts, but the feed is already sorted by "top of day",
 *               so feed order is used as the ranking signal.
 *
 * Normalized post shape:
 *   { source, id, title, url, permalink, score, numComments,
 *     subreddit, author, selftext, created }
 */

const SOURCE = 'reddit';
const USER_AGENT =
  process.env.REDDIT_USER_AGENT || 'daily-ai-signal/0.1 (personal digest)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── OAuth mode ───────────────────────────────────────────────────

let cachedToken = null;

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) {
    throw new Error(`OAuth token failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in - 60) * 1000
  };
  return cachedToken.value;
}

async function fetchSubredditOAuth(subreddit, { sort, timeWindow, limit }) {
  const token = await getAccessToken();
  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top') params.set('t', timeWindow);
  const url = `https://oauth.reddit.com/r/${subreddit}/${sort}?${params}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for r/${subreddit}`);

  const json = await res.json();
  return (json?.data?.children || [])
    .filter(c => c?.kind === 't3' && !c.data?.stickied)
    .map(c => {
      const d = c.data;
      return {
        source: SOURCE,
        id: `${SOURCE}:${d.id}`,
        title: (d.title || '').trim(),
        url: d.url || `https://www.reddit.com${d.permalink}`,
        permalink: `https://www.reddit.com${d.permalink}`,
        score: d.score || 0,
        numComments: d.num_comments || 0,
        subreddit: d.subreddit || subreddit,
        origin: `r/${d.subreddit || subreddit}`,
        author: d.author || 'unknown',
        selftext: (d.selftext || '').slice(0, 1200),
        created: d.created_utc || 0
      };
    });
}

// ── RSS fallback mode ────────────────────────────────────────────

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

function parseAtom(xml, subreddit) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries.map(entry => {
    const rawId = tag(entry, 'id').replace(/^t3_/, '').replace(/_$/, '');
    const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/);
    const permalink = linkMatch ? decodeEntities(linkMatch[1]) : '';
    const title = decodeEntities(tag(entry, 'title'));
    const authorBlock = tag(entry, 'author');
    const author = (authorBlock.match(/<name>([\s\S]*?)<\/name>/)?.[1] || 'unknown').replace(/^\/u\//, '');
    const contentHtml = tag(entry, 'content');
    const selftext = stripHtml(contentHtml).slice(0, 1200);
    const published = tag(entry, 'published');
    return {
      source: SOURCE,
      id: `${SOURCE}:${rawId || permalink}`,
      title,
      url: permalink,
      permalink,
      score: 0, // unknown via RSS
      numComments: 0, // unknown via RSS
      subreddit,
      origin: `r/${subreddit}`,
      author,
      selftext,
      created: published ? Math.floor(new Date(published).getTime() / 1000) : 0
    };
  });
}

async function fetchSubredditRss(subreddit, { sort, timeWindow, limit }) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top') params.set('t', timeWindow);
  const url = `https://www.reddit.com/r/${subreddit}/${sort}/.rss?${params}`;

  // Reddit rate-limits anonymous RSS; retry a few times with backoff on 429/5xx.
  const maxAttempts = Number(process.env.REDDIT_RSS_RETRIES || 2);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/atom+xml' },
      signal: AbortSignal.timeout(20000)
    });
    if (res.ok) {
      const xml = await res.text();
      return parseAtom(xml, subreddit).slice(0, limit);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '0');
      const wait = retryAfter > 0 ? retryAfter * 1000 : 3000 * attempt;
      console.log(`[${SOURCE}] r/${subreddit} ${res.status}; retrying in ${wait}ms`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for r/${subreddit} (rss)`);
  }
  throw new Error(`HTTP 429 for r/${subreddit} (rss, exhausted retries)`);
}

// ── Public collect() ─────────────────────────────────────────────

export async function collect(config) {
  if (!config?.enabled) {
    console.log(`[${SOURCE}] disabled in config; skipping.`);
    return [];
  }

  const {
    subreddits = [],
    sort = 'top',
    timeWindow = 'day',
    limitPerSubreddit = 25,
    minScore = 0
  } = config;

  const useOAuth = Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
  const fetchOne = useOAuth ? fetchSubredditOAuth : fetchSubredditRss;
  console.log(`[${SOURCE}] mode: ${useOAuth ? 'OAuth (JSON)' : 'RSS (no auth, limited data)'}`);

  // Space anonymous RSS requests out (with jitter) to avoid Reddit rate limits.
  const gapMs = useOAuth
    ? Number(process.env.REDDIT_DELAY_MS || 600)
    : Number(process.env.REDDIT_DELAY_MS || 2500);
  const max429SubredditFailures = Number(process.env.REDDIT_RSS_MAX_429_SUBS || 3);

  // In RSS mode Reddit hard-throttles by IP, so only a few subreddits get through
  // per run. Shuffle the order so coverage rotates across daily runs instead of
  // always favoring the first few in the list.
  const order = [...subreddits];
  if (!useOAuth) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const all = [];
  let rss429Failures = 0;
  for (const sub of order) {
    try {
      const posts = await fetchOne(sub, { sort, timeWindow, limit: limitPerSubreddit });
      // Only apply the min-score gate when scores are actually known (OAuth).
      const kept = posts.filter(p => p.score === 0 || p.score >= minScore);
      all.push(...kept);
      console.log(`[${SOURCE}] r/${sub}: ${kept.length} posts`);
      rss429Failures = 0;
      await sleep(gapMs + Math.floor(Math.random() * 700));
    } catch (err) {
      console.error(`[${SOURCE}] r/${sub} failed: ${err.message}`);
      if (!useOAuth && /HTTP 429/.test(err.message)) {
        rss429Failures += 1;
        if (rss429Failures >= max429SubredditFailures) {
          console.warn(
            `[${SOURCE}] too many RSS 429 failures (${rss429Failures}); stopping early to keep runtime reasonable.`
          );
          break;
        }
      }
    }
  }

  const seen = new Set();
  const unique = all.filter(p => (seen.has(p.id) ? false : seen.add(p.id)));
  console.log(`[${SOURCE}] collected ${unique.length} unique posts.`);
  return unique;
}

export const source = SOURCE;
