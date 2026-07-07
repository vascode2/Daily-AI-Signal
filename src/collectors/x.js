/**
 * collectors/x.js — X.com source collector (plugin-style).
 *
 * Supported modes:
 *   - api        : official recent-search endpoint via bearer token
 *   - playwright : external scraper command that returns JSON
 *   - fixture    : load posts from a local JSON file (offline / CI / demo)
 *
 * This keeps the collector modular: `collect(config)` returns the same normalized
 * shape used by other sources, so the rest of the pipeline stays unchanged.
 *
 * Config (config/sources.json -> x):
 *   { enabled, mode, lang, hoursBack, maxResults, minScore, accounts[], keywords[] }
 * The `hoursBack`, `minScore`, `lang`, and `maxResults` gates are applied
 * uniformly after normalization, so every mode behaves consistently. The `lang`
 * gate is best-effort: posts with an unknown language are kept.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const exec = promisify(execCb);
const SOURCE = 'x';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function toEpochSeconds(iso) {
  if (typeof iso === 'number' && Number.isFinite(iso)) {
    // Accept epoch seconds or milliseconds.
    return iso > 1e12 ? Math.floor(iso / 1000) : Math.floor(iso);
  }
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function compactText(text, maxLen = 1200) {
  return decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function titleFromText(text, maxLen = 110) {
  const oneLine = compactText(text, maxLen);
  return oneLine.length > maxLen - 1 ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

function normalizeXPost({ id, text, username, authorId, createdAt, metrics, lang }) {
  const handle = username || authorId || 'unknown';
  const permalink = username
    ? `https://x.com/${username}/status/${id}`
    : `https://x.com/i/web/status/${id}`;
  const like = metrics?.like_count || 0;
  const repost = metrics?.retweet_count || metrics?.repost_count || 0;
  const quote = metrics?.quote_count || 0;
  const reply = metrics?.reply_count || 0;

  return {
    source: SOURCE,
    id: `${SOURCE}:${id}`,
    title: titleFromText(text),
    url: permalink,
    permalink,
    score: like + repost * 2 + quote * 2,
    numComments: reply,
    subreddit: 'X',
    origin: `X/@${handle}`,
    author: handle,
    selftext: compactText(text),
    created: toEpochSeconds(createdAt),
    lang: lang ? String(lang).toLowerCase() : ''
  };
}

function buildApiQuery({ accounts = [], keywords = [], lang }) {
  const userPart = accounts.length
    ? `(${accounts.map(a => `from:${String(a).replace(/^@/, '')}`).join(' OR ')})`
    : '';
  const kwPart = keywords.length ? `(${keywords.map(k => `"${k}"`).join(' OR ')})` : '';

  // Exclude retweets/replies by default for signal quality.
  const filters = ['-is:retweet', '-is:reply'];
  if (lang) filters.push(`lang:${lang}`);
  return [userPart, kwPart, filters.join(' ')].filter(Boolean).join(' ');
}

/**
 * Parse a canonical X/Twitter status URL into { username, id }.
 * Used by grok/scraper rows that provide a post URL instead of a raw id.
 */
function parseXStatusUrl(url) {
  const m = String(url || '').match(/(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i);
  return m ? { username: m[1], id: m[2] } : { username: '', id: '' };
}

/**
 * Map "scraper-shaped" rows (playwright output, fixture files, or Grok x_search
 * results) to normalized posts. Accepts flexible field names so external sources
 * stay easy to write. Rows may supply a raw `id` + `username`, or just a post
 * `url` (from which id/username are derived). Rows without a resolvable id are
 * dropped.
 */
function mapRawRows(rows) {
  return rows
    .map(r => {
      const parsed = parseXStatusUrl(r.url ?? r.permalink ?? '');
      const id = r.id ?? (parsed.id || null);
      if (!id) return null;
      const username = r.username ?? parsed.username ?? undefined;
      return normalizeXPost({
        id,
        text: r.text,
        username,
        authorId: r.authorId,
        createdAt: r.createdAt ?? r.created_at ?? r.created,
        lang: r.lang,
        metrics: {
          like_count: r.likeCount ?? r.like_count ?? 0,
          retweet_count: r.repostCount ?? r.retweet_count ?? r.repost_count ?? 0,
          quote_count: r.quoteCount ?? r.quote_count ?? 0,
          reply_count: r.replyCount ?? r.reply_count ?? 0
        }
      });
    })
    .filter(Boolean)
    .filter(p => p.title && p.id);
}

/**
 * Apply source-config gates uniformly across every mode:
 *   - hoursBack : drop posts older than the window (when `created` is known)
 *   - minScore  : drop low-engagement posts
 *   - lang      : drop posts whose known language differs from config.lang
 *                 (best-effort: posts with unknown lang are kept)
 */
function applyGates(posts, config) {
  const now = Math.floor(Date.now() / 1000);
  const hoursBack = Number(config.hoursBack || 0);
  const since = hoursBack > 0 ? now - hoursBack * 3600 : 0;
  const minScore = Number(config.minScore || 0);
  const lang = config.lang ? String(config.lang).toLowerCase() : '';

  return posts.filter(p => {
    if (since > 0 && p.created > 0 && p.created < since) return false;
    if (minScore > 0 && p.score < minScore) return false;
    if (lang && p.lang && p.lang !== lang) return false;
    return true;
  });
}

async function collectViaApi(config) {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.warn('[x] X_BEARER_TOKEN not set; skipping API mode.');
    return [];
  }

  const base = process.env.X_API_BASE || 'https://api.twitter.com/2';
  const maxResults = Math.min(Math.max(Number(config.maxResults || 50), 10), 100);
  const hasScope = (config.accounts?.length || 0) > 0 || (config.keywords?.length || 0) > 0;
  if (!hasScope) {
    console.warn('[x] No accounts/keywords configured; skipping X API collection.');
    return [];
  }
  const query = buildApiQuery(config);

  const params = new URLSearchParams({
    query,
    max_results: String(maxResults),
    expansions: 'author_id',
    'tweet.fields': 'created_at,public_metrics,author_id,lang',
    'user.fields': 'username'
  });

  // Narrow the API window when hoursBack is set (recent search covers ~7 days).
  const hoursBack = Number(config.hoursBack || 0);
  if (hoursBack > 0) {
    const days = 7 * 24;
    const clamped = Math.min(hoursBack, days);
    // Keep a small safety margin from "now" (API rejects start_time too close to now).
    const startMs = Date.now() - clamped * 3600 * 1000;
    params.set('start_time', new Date(startMs).toISOString());
  }

  const url = `${base}/tweets/search/recent?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API failed (${res.status}): ${body.slice(0, 240)}`);
  }

  const json = await res.json();
  const users = new Map((json.includes?.users || []).map(u => [u.id, u.username]));
  const rows = json.data || [];

  const posts = rows
    .map(t =>
      normalizeXPost({
        id: t.id,
        text: t.text,
        username: users.get(t.author_id),
        authorId: t.author_id,
        createdAt: t.created_at,
        lang: t.lang,
        metrics: t.public_metrics
      })
    )
    .filter(p => p.title && p.id);

  console.log(`[x] collected ${posts.length} posts via API.`);
  return posts;
}

/**
 * Playwright mode expects an external command to print JSON array to stdout.
 * Each item should have at least: id, text, username, createdAt.
 */
async function collectViaPlaywright(config) {
  const command = process.env.X_PLAYWRIGHT_COMMAND;
  if (!command) {
    console.warn('[x] X_PLAYWRIGHT_COMMAND not set; skipping Playwright mode.');
    return [];
  }

  const timeoutMs = Number(process.env.X_PLAYWRIGHT_TIMEOUT_MS || 120000);
  const maxResults = Number(config.maxResults || 50);
  const query = buildApiQuery(config);

  // Pass query + max to external scraper by env vars for a flexible contract.
  const { stdout } = await exec(command, {
    timeout: timeoutMs,
    env: {
      ...process.env,
      X_QUERY: query,
      X_MAX_RESULTS: String(maxResults)
    },
    maxBuffer: 10 * 1024 * 1024
  });

  let rows = [];
  try {
    rows = JSON.parse(stdout || '[]');
    if (!Array.isArray(rows)) rows = [];
  } catch {
    throw new Error('Playwright command output is not valid JSON array.');
  }

  const posts = mapRawRows(rows);
  console.log(`[x] collected ${posts.length} posts via Playwright command.`);
  return posts;
}

/**
 * Fixture mode — load posts from a local JSON file for offline testing, CI, or
 * demos (no X credentials required). The file must contain a JSON array of
 * scraper-shaped rows (same shape Playwright mode expects).
 *
 * Path resolution order:
 *   1. config.fixturePath  2. process.env.X_FIXTURE_PATH  3. test/fixtures/x-sample.json
 */
async function collectViaFixture(config) {
  const rel =
    config.fixturePath || process.env.X_FIXTURE_PATH || 'test/fixtures/x-sample.json';
  const path = isAbsolute(rel) ? rel : join(ROOT, rel);

  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    console.warn(`[x] fixture not found at ${path}; skipping (${err.code || err.message}).`);
    return [];
  }

  let rows = JSON.parse(raw);
  if (!Array.isArray(rows)) rows = [];

  const posts = mapRawRows(rows);
  console.log(`[x] collected ${posts.length} posts via fixture (${rel}).`);
  return posts;
}

// ── Grok (xAI) mode ──────────────────────────────────────────────
//
// Uses the xAI Responses API with the built-in `x_search` tool to pull recent,
// high-signal X posts. This is the mode to use with a Grok/xAI API key (which is
// NOT the same as a Twitter/X developer bearer token).
//
// Docs: https://docs.x.ai/developers/tools/x-search

/** Extract assistant text from an xAI Responses API payload (defensive). */
function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }
  const parts = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  if (parts.length) return parts.join('\n');
  // Chat-completions-shaped fallback.
  const choice = data?.choices?.[0]?.message?.content;
  return typeof choice === 'string' ? choice : '';
}

/** Pull the first JSON array out of a possibly-fenced / prose-wrapped string. */
function extractJsonArray(text) {
  if (!text) return [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function buildGrokPrompt(config) {
  const accounts = (config.accounts || []).map(a => String(a).replace(/^@/, ''));
  const keywords = config.keywords || [];
  const maxResults = Math.min(Math.max(Number(config.maxResults || 30), 5), 50);

  const accountLine = accounts.length
    ? `Prioritize posts from these accounts: ${accounts.map(a => `@${a}`).join(', ')}.`
    : '';
  const kwLine = keywords.length
    ? `Focus on these topics/keywords: ${keywords.join(', ')}.`
    : '';
  const langLine = config.lang ? `Prefer posts written in ${config.lang}.` : '';

  return `You are collecting recent, high-signal posts from X (Twitter) for a daily AI engineering digest.

${accountLine}
${kwLine}
${langLine}
Only include substantive posts (product launches, technical insights, tools, guides, benchmarks, announcements). Exclude replies, memes, giveaways, and pure hype.

Use the x_search tool to find real posts, then return ONLY a JSON array (no prose, no markdown fences) of up to ${maxResults} items. Each item MUST have exactly these fields:
- "url": the canonical post URL, e.g. "https://x.com/<handle>/status/<id>" (must be a real post you found)
- "username": the author's handle without @
- "text": the full post text (plain text)
- "createdAt": ISO 8601 timestamp of the post
- "lang": two-letter language code (e.g. "en"), or "" if unknown
- "likeCount", "repostCount", "replyCount", "quoteCount": integer engagement counts if visible, else 0

Return [] if nothing relevant is found. Output must be valid JSON and nothing else.`;
}

async function collectViaGrok(config) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!apiKey) {
    console.warn('[x] XAI_API_KEY (Grok) not set; skipping grok mode.');
    return [];
  }

  const base = process.env.XAI_API_BASE || 'https://api.x.ai/v1';
  const model = config.model || process.env.XAI_MODEL || 'grok-4.3';
  const timeoutMs = Number(process.env.XAI_REQUEST_TIMEOUT_MS || 120000);

  const accounts = (config.accounts || [])
    .map(a => String(a).replace(/^@/, ''))
    .slice(0, 20);

  const xSearch = { type: 'x_search' };
  if (accounts.length) xSearch.allowed_x_handles = accounts;

  const hoursBack = Number(config.hoursBack || 0);
  if (hoursBack > 0) {
    const now = Date.now();
    const fromMs = now - hoursBack * 3600 * 1000;
    xSearch.from_date = isoDate(new Date(fromMs));
    xSearch.to_date = isoDate(new Date(now));
  }

  const body = {
    model,
    input: [{ role: 'user', content: buildGrokPrompt(config) }],
    tools: [xSearch]
  };

  const res = await fetch(`${base}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xAI Responses API failed (${res.status}): ${text.slice(0, 240)}`);
  }

  const data = await res.json();
  const rows = extractJsonArray(extractResponsesText(data));
  const posts = mapRawRows(rows);
  console.log(`[x] collected ${posts.length} posts via Grok x_search (model=${model}).`);
  return posts;
}

async function collectForMode(mode, config) {
  switch (mode) {
    case 'playwright':
      return collectViaPlaywright(config);
    case 'fixture':
      return collectViaFixture(config);
    case 'grok':
      return collectViaGrok(config);
    case 'api':
    default:
      return collectViaApi(config);
  }
}

export async function collect(config) {
  if (!config?.enabled) {
    console.log('[x] disabled in config; skipping.');
    return [];
  }

  const mode = String(config.mode || 'api').toLowerCase();
  try {
    const raw = await collectForMode(mode, config);
    const seen = new Set();
    const unique = raw.filter(p => (seen.has(p.id) ? false : seen.add(p.id)));
    const gated = applyGates(unique, config);
    if (gated.length !== unique.length) {
      console.log(
        `[x] gates: kept ${gated.length}/${unique.length} (minScore=${config.minScore || 0}, hoursBack=${config.hoursBack || 0}, lang=${config.lang || 'any'}).`
      );
    }

    // Enforce maxResults uniformly across modes, keeping the highest-signal posts.
    const cap = Number(config.maxResults || 0);
    const sorted = gated.sort((a, b) => b.score - a.score);
    const kept = cap > 0 ? sorted.slice(0, cap) : sorted;
    return kept;
  } catch (err) {
    console.error(`[x] ${mode} mode failed: ${err.message}`);
    return [];
  }
}

export const source = SOURCE;

// Exported for unit tests only.
export const __test__ = {
  buildApiQuery,
  normalizeXPost,
  mapRawRows,
  applyGates,
  compactText,
  toEpochSeconds,
  parseXStatusUrl,
  extractResponsesText,
  extractJsonArray,
  buildGrokPrompt
};
