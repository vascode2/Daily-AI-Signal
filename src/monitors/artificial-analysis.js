/**
 * monitors/artificial-analysis.js — watch https://artificialanalysis.ai/articles
 * and report articles published inside a recent date window.
 *
 * The site publishes no RSS feed, so this reads two things:
 *   1. The article index, for the current list of slugs (newest first).
 *   2. Each candidate article's OpenGraph meta tags, for title / description /
 *      publish date. Meta tags are a stable public contract; the site's
 *      Next.js payload is an internal detail, so it is only used as a bonus
 *      source of body text for a richer summary.
 *
 * "New" is a date window rather than remembered state, because the digest runs
 * on ephemeral CI runners with nothing to persist between runs. With the
 * default `lookbackDays: 1` a daily run reports each article exactly once:
 * a piece published on the 31st is picked up by the run on the 1st, and is
 * outside the window by the 2nd.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Slugs that are asset paths or build chunks rather than articles. */
function isArticleSlug(slug) {
  if (/^[0-9a-f]{20,}-\d+x\d+$/.test(slug)) return false; // CDN image derivative
  if (/^page-[0-9a-f]+$/.test(slug)) return false; // Next.js route chunk
  return slug.length > 6;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

async function fetchText(url, { retries = 3, backoffMs = 2000, timeoutMs = 25000 }) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) return await res.text();
      // 4xx other than 429 will not improve on retry.
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
      if (/HTTP 4/.test(err.message) && !/HTTP 429/.test(err.message)) break;
    }
    if (attempt < retries) await sleep(backoffMs * attempt);
  }
  throw new Error(`${lastErr?.message || 'request failed'} for ${url}`);
}

/** Read a `<meta property|name="...">` value. */
export function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const tag = html.match(pattern)?.[0];
  if (!tag) return '';
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1] || '';
  return decodeEntities(content).trim();
}

/** Article slugs in index order (newest first). */
export function parseIndex(html) {
  const slugs = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/articles\/([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    const slug = m[1];
    if (seen.has(slug) || !isArticleSlug(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return slugs;
}

/**
 * Best-effort body text from the Next.js RSC payload.
 *
 * This reads an internal format, so it never throws and is never required —
 * `og:description` is the guaranteed summary source.
 */
export function parseBody(html, { maxChars = 3000 } = {}) {
  try {
    let buf = '';
    for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
      try {
        buf += JSON.parse(`"${m[1]}"`);
      } catch {
        /* skip malformed chunk */
      }
    }
    if (!buf) return '';

    const seen = new Set();
    const paragraphs = [];
    for (const m of buf.matchAll(/"children":"((?:[^"\\]|\\.){60,})"/g)) {
      let text;
      try {
        text = JSON.parse(`"${m[1]}"`);
      } catch {
        continue;
      }
      text = text.trim();
      // Skip markup fragments, RSC references, and repeated title nodes.
      if (!text || text.includes('$') || text.startsWith('<') || seen.has(text)) continue;
      seen.add(text);
      paragraphs.push(text);
      if (paragraphs.join(' ').length > maxChars) break;
    }
    return paragraphs.join('\n\n').slice(0, maxChars);
  } catch {
    return '';
  }
}

/** Parse one article page into a normalized record. */
export function parseArticle(html, { slug, baseUrl = 'https://artificialanalysis.ai' } = {}) {
  return {
    source: 'artificialanalysis',
    slug,
    title: metaContent(html, 'og:title') || metaContent(html, 'twitter:title'),
    url: metaContent(html, 'og:url') || `${baseUrl}/articles/${slug}`,
    description:
      metaContent(html, 'og:description') || metaContent(html, 'twitter:description'),
    published: metaContent(html, 'article:published_time'),
    body: parseBody(html)
  };
}

/** Midnight UTC of the oldest date still considered "new". */
export function windowStart(lookbackDays, now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - Math.max(0, lookbackDays));
  return start;
}

/**
 * Select the articles published inside the window from already-parsed records.
 * Split out from the network path so it can be tested offline.
 */
export function selectRecent(parsed, { lookbackDays = 1, maxArticles = 5, now } = {}) {
  const cutoff = windowStart(lookbackDays, now);
  const inWindow = [];

  for (const article of parsed) {
    if (!article.published) continue;
    const publishedAt = new Date(article.published);
    if (Number.isNaN(publishedAt.getTime())) continue;
    // The index is newest-first, so the first out-of-window article ends the scan.
    if (publishedAt < cutoff) break;
    inWindow.push({ ...article, publishedAt });
  }

  inWindow.sort((a, b) => b.publishedAt - a.publishedAt);
  return { articles: inWindow.slice(0, maxArticles), cutoff };
}

/**
 * Find articles published within the lookback window.
 *
 * @param {object} config - parsed config/articles.json
 * @returns {Promise<object>} { source, url, articles, lookbackDays, indexed, checked, failed }
 */
export async function findNewArticles(config = {}) {
  const baseUrl = config.baseUrl || 'https://artificialanalysis.ai';
  const indexUrl = `${baseUrl}${config.indexPath || '/articles'}`;
  const lookbackDays = config.lookbackDays ?? 1;
  const fetchOpts = {
    retries: config.retries || 3,
    backoffMs: config.backoffMs || 2000,
    timeoutMs: config.timeoutMs || 25000
  };

  const slugs = parseIndex(await fetchText(indexUrl, fetchOpts));
  console.log(`[articles] ${slugs.length} articles listed on ${indexUrl}`);

  // The index is newest-first, so only the head needs its date checked.
  const candidates = slugs.slice(0, config.maxDetailFetches || 12);
  const cutoff = windowStart(lookbackDays);
  const parsed = [];
  const failed = [];

  for (const slug of candidates) {
    try {
      const html = await fetchText(`${baseUrl}/articles/${slug}`, fetchOpts);
      const article = parseArticle(html, { slug, baseUrl });
      if (!article.published) {
        console.warn(`[articles] ${slug}: no publish date; skipping.`);
        continue;
      }
      parsed.push(article);
      // Stop as soon as the feed is older than the window.
      if (new Date(article.published) < cutoff) break;
    } catch (err) {
      failed.push(slug);
      console.error(`[articles] ${slug} failed: ${err.message}`);
    }
    await sleep(config.delayMs ?? 800);
  }

  const { articles } = selectRecent(parsed, {
    lookbackDays,
    maxArticles: config.maxArticles || 5
  });

  console.log(
    `[articles] ${articles.length} new since ${cutoff.toISOString().slice(0, 10)} ` +
      `(checked ${parsed.length + failed.length} of ${slugs.length}).`
  );

  return {
    source: config.name || 'Artificial Analysis',
    url: indexUrl,
    articles,
    lookbackDays,
    indexed: slugs.length,
    checked: parsed.length + failed.length,
    failed
  };
}
