/**
 * scripts/e2e-x.js — end-to-end smoke test for the X.com source.
 *
 * Runs the real pipeline path for X only, WITHOUT touching Notion:
 *   X fixture -> filter/group -> Gemini summarize -> render Markdown (stdout).
 *
 * Purpose: prove X data flows all the way through the AI summarization step.
 * Uses the local fixture so it needs no X credentials. If GEMINI_API_KEY is set
 * it exercises the live Gemini call; otherwise it uses the non-AI fallback.
 *
 * Run: `npm run e2e:x`
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { collect } from '../src/collectors/x.js';
import { filterAndGroup } from '../src/filter.js';
import { summarizeGroups } from '../src/summarize.js';
import { buildDigest, digestDate } from '../src/render-markdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function main() {
  const topicsConfig = JSON.parse(await readFile(join(ROOT, 'config/topics.json'), 'utf-8'));

  console.log('[e2e:x] collecting from X fixture...');
  const posts = await collect({
    enabled: true,
    mode: 'fixture',
    fixturePath: process.env.X_FIXTURE_PATH || 'test/fixtures/x-sample.json',
    minScore: 3,
    hoursBack: 0
  });
  console.log(`[e2e:x] collected ${posts.length} X posts.`);
  if (posts.length === 0) throw new Error('No X posts collected from fixture.');

  const groups = filterAndGroup(posts, topicsConfig);
  if (groups.length === 0) throw new Error('No topic groups formed from X posts.');

  console.log('[e2e:x] summarizing with Gemini (or fallback)...');
  const sections = await summarizeGroups(groups);

  const date = digestDate();
  const originCounts = {};
  for (const g of groups) {
    for (const p of g.posts) {
      const key = p.origin || `r/${p.subreddit}`;
      originCounts[key] = (originCounts[key] || 0) + 1;
    }
  }
  const kept = groups.reduce((n, g) => n + g.posts.length, 0);
  const markdown = buildDigest({
    date,
    sections,
    stats: { collected: posts.length, kept, topics: groups.length, originCounts }
  });

  console.log('\n===== X END-TO-END DIGEST (not saved, not published) =====\n');
  console.log(markdown);

  // Basic assertions so this can double as a CI smoke test.
  if (!markdown.includes('X/@')) {
    throw new Error('Digest is missing X source attribution (X/@...).');
  }
  console.log('\n[e2e:x] OK — X data flowed through the full summarization pipeline.');
}

main().catch(err => {
  console.error('[e2e:x] FAILED:', err.message);
  process.exit(1);
});
