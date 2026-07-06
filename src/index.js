/**
 * index.js — daily-ai-signal pipeline orchestrator.
 *
 * Pipeline:
 *   1. Collect posts from every enabled source (Reddit for the MVP).
 *   2. Filter to relevant topics, rank by usefulness, group by topic.
 *   3. Summarize each group with Gemini.
 *   4. Render a Markdown digest and save it to output/.
 *   5. Publish the digest to Notion (unless skipped).
 *
 * Run: `npm start`            (full pipeline)
 *      `npm run collect`      (skip Notion, local Markdown only)
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as reddit from './collectors/reddit.js';
import * as hackernews from './collectors/hackernews.js';
import { filterAndGroup } from './filter.js';
import { summarizeGroups } from './summarize.js';
import { buildDigest, saveDigest, digestDate } from './render-markdown.js';
import { publishDigest } from './notion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Registry of available source collectors. Add new sources here later.
const COLLECTORS = { reddit, hackernews };

async function loadJson(relPath) {
  return JSON.parse(await readFile(join(ROOT, relPath), 'utf-8'));
}

function truthy(v) {
  return String(v).toLowerCase() === 'true';
}

async function main() {
  const skipNotion =
    process.argv.includes('--skip-notion') || truthy(process.env.DIGEST_SKIP_NOTION);
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');

  const sources = await loadJson('config/sources.json');
  const topicsConfig = await loadJson('config/topics.json');
  const date = digestDate();

  console.log(`\n=== ${isKorean ? '데일리 AI 시그널' : 'Daily AI Signal'} — ${date} ===\n`);

  // 1. Collect from every configured source.
  console.log('[1/5] Collecting posts...');
  const collected = [];
  for (const [name, config] of Object.entries(sources)) {
    const collector = COLLECTORS[name];
    if (!collector) {
      console.warn(`[collect] no collector registered for "${name}"; skipping.`);
      continue;
    }
    const posts = await collector.collect(config);
    collected.push(...posts);
  }
  console.log(`  collected ${collected.length} posts total.`);

  // 2. Filter + rank + group.
  console.log('[2/5] Filtering, ranking, grouping...');
  const groups = filterAndGroup(collected, topicsConfig);
  const keptCount = groups.reduce((n, g) => n + g.posts.length, 0);

  // 3. Summarize each group with Gemini.
  console.log('[3/5] Summarizing with Gemini...');
  const sections = await summarizeGroups(groups);

  // 4. Render + save Markdown.
  console.log('[4/5] Rendering Markdown...');

  // Compute per-source/community breakdown from filtered posts.
  const originCounts = {};
  for (const g of groups) {
    for (const p of g.posts) {
      const key = p.origin || `r/${p.subreddit}`;
      originCounts[key] = (originCounts[key] || 0) + 1;
    }
  }

  const markdown = buildDigest({
    date,
    sections,
    stats: { collected: collected.length, kept: keptCount, topics: groups.length, originCounts }
  });
  await saveDigest(markdown, date, ROOT);

  // 5. Publish to Notion.
  if (skipNotion) {
    console.log('[5/5] Skipping Notion (--skip-notion / DIGEST_SKIP_NOTION).');
  } else {
    const token = process.env.NOTION_TOKEN;
    const parentPageId = process.env.NOTION_PAGE_ID;
    if (!token || !parentPageId) {
      console.warn('[5/5] NOTION_TOKEN or NOTION_PAGE_ID not set; skipping Notion.');
    } else {
      console.log('[5/5] Publishing to Notion...');
      const notionTitle = isKorean
        ? `🤖 데일리 AI 시그널 — ${date}`
        : `🤖 Daily AI Signal — ${date}`;
      const page = await publishDigest({
        markdown,
        title: notionTitle,
        parentPageId,
        token
      });
      if (page?.url) console.log(`  published: ${page.url}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
