/**
 * test/articles.test.js — offline tests for the Artificial Analysis monitor.
 *
 * Uses a saved page fixture so parsing, the "new since" window, rendering, and
 * the Notion conversion are deterministic (no network, no Gemini).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  metaContent,
  parseIndex,
  parseArticle,
  parseBody,
  selectRecent,
  windowStart
} from '../src/monitors/artificial-analysis.js';
import { buildArticlesSection, buildDigest } from '../src/render-markdown.js';
import { summarizeArticles } from '../src/summarize.js';
import { markdownToNotionBlocks } from '../src/notion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const loadFixture = name => readFile(join(ROOT, 'test/fixtures', name), 'utf-8');

test('parseIndex keeps article slugs and drops assets and build chunks', async () => {
  const slugs = parseIndex(await loadFixture('aa-index.html'));

  assert.ok(slugs.length >= 5, `expected several slugs, got ${slugs.length}`);
  assert.ok(slugs.includes('claude-opus-5-leader-agentic-knowledge-work'));

  // CDN image derivatives and Next.js route chunks live under the same path.
  assert.ok(
    !slugs.some(s => /^[0-9a-f]{20,}-\d+x\d+$/.test(s)),
    `image derivatives leaked in: ${slugs.join(', ')}`
  );
  assert.ok(!slugs.some(s => s.startsWith('page-')), 'route chunk leaked in');

  // Index order is newest-first and the scan depends on it.
  assert.equal(slugs[0], 'deepseek-v4-flash-0731-scores-50-on-the-artificial-analysis-intelligence-index-10-points-above-previous-deepseek-v4-flash');
});

test('parseArticle reads OpenGraph metadata', async () => {
  const article = parseArticle(await loadFixture('aa-article.html'), {
    slug: 'claude-opus-5-leader-agentic-knowledge-work'
  });

  assert.equal(article.title, 'Claude Opus 5: the new leader in agentic knowledge work');
  assert.equal(article.published, '2026-07-24');
  assert.match(article.url, /^https:\/\/artificialanalysis\.ai\/articles\//);
  assert.match(article.description, /AA-Briefcase/);
  assert.equal(article.source, 'artificialanalysis');
});

test('metaContent decodes HTML entities and tolerates missing tags', () => {
  const html = '<meta property="og:title" content="Sol &amp; Terra &#39;25"/>';
  assert.equal(metaContent(html, 'og:title'), "Sol & Terra '25");
  assert.equal(metaContent(html, 'og:description'), '', 'missing tag -> empty string');
});

test('parseBody extracts prose and never throws on unexpected markup', async () => {
  const body = parseBody(await loadFixture('aa-article.html'));
  assert.ok(body.length > 200, `expected article prose, got ${body.length} chars`);
  assert.ok(!body.includes('"children"'), 'raw payload keys must not leak into the summary');

  // Body text is a bonus from an internal format; failure must degrade, not throw.
  assert.equal(parseBody('<html><body>no payload</body></html>'), '');
  assert.equal(parseBody(''), '');
});

test('the lookback window reports each article exactly once per daily run', () => {
  const parsed = [
    { title: 'Aug 1 piece', published: '2026-08-01', url: 'u1' },
    { title: 'Jul 31 piece', published: '2026-07-31', url: 'u2' },
    { title: 'Jul 30 piece', published: '2026-07-30', url: 'u3' }
  ];

  // Run on Aug 1: window covers Jul 31 - Aug 1.
  const aug1 = selectRecent(parsed, { lookbackDays: 1, now: new Date('2026-08-01T07:30:00Z') });
  assert.deepEqual(aug1.articles.map(a => a.published), ['2026-08-01', '2026-07-31']);

  // Run on Aug 2: Jul 31 has aged out, so it is not repeated.
  const aug2 = selectRecent(parsed, { lookbackDays: 1, now: new Date('2026-08-02T07:30:00Z') });
  assert.deepEqual(aug2.articles.map(a => a.published), ['2026-08-01']);
});

test('selectRecent stops at the first out-of-window article and caps the count', () => {
  const parsed = [
    { title: 'new', published: '2026-08-01', url: 'u1' },
    { title: 'old', published: '2026-01-01', url: 'u2' },
    // Newest-first ordering is assumed, so nothing after the cutoff is considered.
    { title: 'stray newer', published: '2026-08-01', url: 'u3' }
  ];
  const { articles } = selectRecent(parsed, {
    lookbackDays: 1,
    now: new Date('2026-08-01T07:30:00Z')
  });
  assert.deepEqual(articles.map(a => a.url), ['u1']);

  const many = Array.from({ length: 9 }, (_, i) => ({
    title: `a${i}`,
    published: '2026-08-01',
    url: `u${i}`
  }));
  assert.equal(
    selectRecent(many, { lookbackDays: 1, maxArticles: 3, now: new Date('2026-08-01T07:30:00Z') })
      .articles.length,
    3
  );
});

test('windowStart is timezone-stable at UTC midnight', () => {
  const start = windowStart(1, new Date('2026-08-01T23:59:00Z'));
  assert.equal(start.toISOString(), '2026-07-31T00:00:00.000Z');
  assert.equal(windowStart(0, new Date('2026-08-01T00:00:01Z')).toISOString(), '2026-08-01T00:00:00.000Z');
});

test('the section states plainly when nothing new was published', () => {
  const block = buildArticlesSection({
    result: {
      source: 'Artificial Analysis',
      url: 'https://artificialanalysis.ai/articles',
      articles: [],
      lookbackDays: 1
    },
    section: ''
  });

  assert.match(block, /## 📊 Artificial Analysis/);
  assert.match(block, /No new articles in the last 1 day/);
  assert.match(block, /artificialanalysis\.ai\/articles/, 'links to the index so silence is checkable');
});

test('the section renders new articles and flags unreadable pages', () => {
  const block = buildArticlesSection({
    result: {
      source: 'Artificial Analysis',
      url: 'https://artificialanalysis.ai/articles',
      articles: [
        { title: 'A', url: 'https://x/a', published: '2026-08-01' },
        { title: 'B', url: 'https://x/b', published: '2026-07-31' }
      ],
      lookbackDays: 1,
      failed: ['broken-slug']
    },
    section: '- **[A](https://x/a)** — something changed.'
  });

  assert.match(block, /> 2 new articles · 2026-07-31 → 2026-08-01/);
  assert.match(block, /⚠️ 1 article page\(s\) could not be read/);
  assert.match(block, /\*\*\[A\]\(https:\/\/x\/a\)\*\*/);
});

test('a missing Gemini summary falls back to linked titles', () => {
  const block = buildArticlesSection({
    result: {
      articles: [{ title: 'A', url: 'https://x/a', published: '2026-08-01' }],
      lookbackDays: 1
    },
    section: ''
  });
  assert.match(block, /- \*\*\[A\]\(https:\/\/x\/a\)\*\*/, 'never renders an empty section body');
});

test('summarizeArticles falls back to the site summaries without Gemini', async t => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  });

  const md = await summarizeArticles([
    { title: 'DeepSeek V4 Flash', url: 'https://x/1', description: 'Scores 50 on the index.' }
  ]);
  assert.match(md, /- \*\*\[DeepSeek V4 Flash\]\(https:\/\/x\/1\)\*\* — Scores 50 on the index\./);
  assert.equal(await summarizeArticles([]), '', 'nothing new -> empty summary');
});

test('the articles section survives conversion to Notion blocks', () => {
  const markdown = buildDigest({
    date: '2026-08-01',
    sections: [{ topic: 'Local LLMs', section: '- **[A post](https://example.com)** — why.' }],
    lead: buildArticlesSection({
      result: {
        source: 'Artificial Analysis',
        url: 'https://artificialanalysis.ai/articles',
        articles: [{ title: 'DeepSeek V4 Flash', url: 'https://x/1', published: '2026-08-01' }],
        lookbackDays: 1
      },
      section: [
        '- **[DeepSeek V4 Flash](https://x/1)** — scores 50 on the index.',
        '  - **Why it matters:** open weights close the gap.'
      ].join('\n')
    }),
    stats: { collected: 10, kept: 1, topics: 1, originCounts: { 'Hacker News': 1 } }
  });

  const blocks = markdownToNotionBlocks(markdown);
  const heading = blocks.find(
    b => b.type === 'heading_2' &&
      b.heading_2.rich_text.map(t => t.text.content).join('').includes('Artificial Analysis')
  );
  assert.ok(heading, 'the section heading reaches Notion');

  // The nested "Why it matters" line must hang off its article, not float free.
  const item = blocks.find(b => b.type === 'bulleted_list_item');
  const children = item.bulleted_list_item.children || [];
  assert.equal(children.length, 1, 'indented detail becomes a child block');
  assert.match(
    children[0].bulleted_list_item.rich_text.map(t => t.text.content).join(''),
    /Why it matters/
  );

  const link = item.bulleted_list_item.rich_text.find(t => t.text.link);
  assert.ok(link, 'the article link survives conversion');
  assert.equal(link.text.link.url, 'https://x/1');
});

test('list nesting never exceeds the depth Notion accepts on create', () => {
  const blocks = markdownToNotionBlocks(
    ['- level one', '  - level two', '    - level three', '      - level four'].join('\n')
  );
  assert.equal(blocks.length, 1);

  const depthOf = (block, d = 1) => {
    const children = block[block.type].children || [];
    return children.length === 0 ? d : Math.max(...children.map(c => depthOf(c, d + 1)));
  };
  assert.equal(depthOf(blocks[0]), 2, 'deeper markdown levels collapse onto the parent');

  // Nothing is dropped — deeper items are flattened, not discarded.
  assert.deepEqual(
    blocks[0].bulleted_list_item.children.map(c =>
      c.bulleted_list_item.rich_text.map(t => t.text.content).join('')
    ),
    ['level two', 'level three', 'level four']
  );
});

test('ordered lists stay contiguous so Notion does not restart numbering', () => {
  const blocks = markdownToNotionBlocks(
    ['1. first', '   - detail', '2. second', '   - detail', '3. third'].join('\n')
  );

  const numbered = blocks.filter(b => b.type === 'numbered_list_item');
  assert.equal(numbered.length, 3);
  assert.deepEqual(
    blocks.slice(blocks.indexOf(numbered[0]), blocks.indexOf(numbered[0]) + 3).map(b => b.type),
    ['numbered_list_item', 'numbered_list_item', 'numbered_list_item'],
    'nothing may be interleaved between numbered entries'
  );
});
