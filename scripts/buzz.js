/**
 * scripts/buzz.js — standalone "what AI is everyone talking about right now?" run.
 *
 * Scans the AI subreddits in config/buzz.json for the last N hours, ranks the
 * models/tools by how much they are being discussed, scores the mood, and asks
 * Gemini to explain why each of the top ones is spiking.
 *
 * Usage:
 *   npm run buzz                 # last 4h (config default), saves a Markdown report
 *   node scripts/buzz.js --hours=8 --top=5
 *   node scripts/buzz.js --json  # raw analysis as JSON (no Gemini call)
 *   node scripts/buzz.js --notion  # also publish the report to Notion
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runBuzz } from '../src/research/buzz.js';
import { summarizeBuzz } from '../src/summarize.js';
import { buildBuzzSection, saveResearch, digestDate, digestTime } from '../src/render-markdown.js';
import { publishDigest } from '../src/notion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function flag(name) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : true;
}

async function main() {
  const config = JSON.parse(await readFile(join(ROOT, 'config/buzz.json'), 'utf-8'));

  const hoursBack = Number(flag('hours') || process.env.BUZZ_HOURS_BACK || config.hoursBack || 4);
  const topN = Number(flag('top') || process.env.BUZZ_TOP_N || config.topN || 3);
  const asJson = Boolean(flag('json'));

  // In --json mode stdout must contain only JSON, so progress logs go to stderr.
  const log = asJson ? (...args) => console.error(...args) : (...args) => console.log(...args);
  const originalLog = console.log;
  if (asJson) console.log = (...args) => console.error(...args);

  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');

  log(`\n=== ${isKorean ? 'AI 화제 리서치' : 'AI Buzz research'} — last ${hoursBack}h ===\n`);

  const result = await runBuzz(config, { hoursBack, topN });

  if (asJson) {
    console.log = originalLog;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (result.top.length === 0) {
    console.log(`No AI stood out in the last ${result.hoursBack}h (${result.totalPosts} posts).`);
  } else {
    console.log('Top mentions:');
    for (const [i, e] of result.top.entries()) {
      console.log(
        `  ${i + 1}. ${e.name} — buzz ${e.buzzScore}, ${e.mentions} mentions, ` +
          `${e.subreddits.length} subs, ${e.sentiment.summary}`
      );
    }
    console.log('');
  }

  const section = await summarizeBuzz(result);
  const body = buildBuzzSection({ result, section });

  const title = isKorean
    ? `🔥 AI 화제 리서치 — ${digestDate()} ${digestTime()}`
    : `🔥 AI Buzz Research — ${digestDate()} ${digestTime()}`;
  const markdown = `# ${title}\n\n${body}`;

  await saveResearch(markdown, ROOT);

  if (flag('notion')) {
    const token = process.env.NOTION_TOKEN;
    const parentPageId = process.env.NOTION_PAGE_ID;
    if (!token || !parentPageId) {
      console.warn('[notion] NOTION_TOKEN or NOTION_PAGE_ID not set; skipping publish.');
    } else {
      const page = await publishDigest({ markdown, title, parentPageId, token });
      if (page?.url) console.log(`  published: ${page.url}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
