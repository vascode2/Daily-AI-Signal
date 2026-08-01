/**
 * index.js — daily-ai-signal pipeline orchestrator.
 *
 * Pipeline:
 *   1. Collect posts from every enabled source (Reddit for the MVP).
 *   2. Filter to relevant topics, rank by usefulness, group by topic.
 *   3. Summarize each group with Gemini.
 *   4. Research short-window "AI buzz" (what people are talking about right now).
 *   5. Render a Markdown digest and save it to output/.
 *   6. Publish the digest to Notion (unless skipped).
 *
 * Run: `npm start`            (full pipeline)
 *      `npm run collect`      (skip Notion, local Markdown only)
 *      `npm run buzz`         (buzz research only, standalone report)
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as reddit from './collectors/reddit.js';
import * as hackernews from './collectors/hackernews.js';
import * as x from './collectors/x.js';
import { filterAndGroup } from './filter.js';
import { summarizeGroups, summarizeBuzz } from './summarize.js';
import { buildDigest, buildBuzzSection, saveDigest, digestDate } from './render-markdown.js';
import { publishDigest } from './notion.js';
import { runBuzz } from './research/buzz.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Registry of available source collectors. Add new sources here later.
const COLLECTORS = { reddit, hackernews, x };

async function loadJson(relPath) {
  return JSON.parse(await readFile(join(ROOT, relPath), 'utf-8'));
}

function truthy(v) {
  return String(v).toLowerCase() === 'true';
}

async function main() {
  const skipNotion =
    process.argv.includes('--skip-notion') || truthy(process.env.DIGEST_SKIP_NOTION);
  const skipBuzz = process.argv.includes('--skip-buzz') || truthy(process.env.DIGEST_SKIP_BUZZ);
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');

  const sources = await loadJson('config/sources.json');
  const topicsConfig = await loadJson('config/topics.json');
  const buzzConfig = await loadJson('config/buzz.json');
  const date = digestDate();

  console.log(`\n=== ${isKorean ? '데일리 AI 시그널' : 'Daily AI Signal'} — ${date} ===\n`);

  // 1. Collect from every configured source.
  console.log('[1/6] Collecting posts...');
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
  console.log('[2/6] Filtering, ranking, grouping...');
  const groups = filterAndGroup(collected, topicsConfig);
  const keptCount = groups.reduce((n, g) => n + g.posts.length, 0);

  // 3. Summarize each group with Gemini.
  console.log('[3/6] Summarizing with Gemini...');
  const sections = await summarizeGroups(groups);

  // 4. Short-window buzz research (which AI is being talked about right now).
  let buzzBlock = '';
  const buzzHours = Number(process.env.BUZZ_HOURS_BACK) || buzzConfig.hoursBack || 4;
  const buzzTopN = Number(process.env.BUZZ_TOP_N) || buzzConfig.topN || 3;
  if (skipBuzz || !buzzConfig.enabled) {
    console.log('[4/6] Skipping buzz research (disabled or --skip-buzz).');
  } else {
    console.log(`[4/6] Researching AI buzz (last ${buzzHours}h)...`);
    try {
      const result = await runBuzz(buzzConfig, { hoursBack: buzzHours, topN: buzzTopN });
      const buzzSection = await summarizeBuzz(result);
      buzzBlock = buildBuzzSection({ result, section: buzzSection });
    } catch (err) {
      // Research is a bonus section — never let it break the daily digest.
      console.error(`[buzz] failed: ${err.message}`);
    }
  }

  // 5. Render + save Markdown.
  console.log('[5/6] Rendering Markdown...');

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
    buzz: buzzBlock,
    stats: { collected: collected.length, kept: keptCount, topics: groups.length, originCounts }
  });
  await saveDigest(markdown, date, ROOT);

  // 6. Publish to Notion.
  if (skipNotion) {
    console.log('[6/6] Skipping Notion (--skip-notion / DIGEST_SKIP_NOTION).');
  } else {
    const token = process.env.NOTION_TOKEN;
    const parentPageId = process.env.NOTION_PAGE_ID;
    if (!token || !parentPageId) {
      console.warn('[6/6] NOTION_TOKEN or NOTION_PAGE_ID not set; skipping Notion.');
    } else {
      console.log('[6/6] Publishing to Notion...');
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
