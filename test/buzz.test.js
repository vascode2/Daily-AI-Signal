/**
 * test/buzz.test.js — offline tests for the AI-buzz research feature.
 *
 * Uses a fixed post fixture so ranking, entity matching, sentiment, and rendering
 * are fully deterministic (no network, no Gemini).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyzeBuzz, buildRegistry, scanMentions } from '../src/research/buzz.js';
import { scoreText, labelFor, describeSentiment } from '../src/research/sentiment.js';
import { summarizeBuzz } from '../src/summarize.js';
import { buildBuzzSection, buildDigest } from '../src/render-markdown.js';
import { markdownToNotionBlocks } from '../src/notion.js';
import { parseCommentListing } from '../src/collectors/reddit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const loadJson = async rel => JSON.parse(await readFile(join(ROOT, rel), 'utf-8'));

async function analyzeFixture(overrides = {}) {
  const config = await loadJson('config/buzz.json');
  const posts = await loadJson('test/fixtures/reddit-buzz-sample.json');
  const now = 2000;
  return {
    config,
    posts,
    result: analyzeBuzz(posts, {
      ...config,
      now,
      windowStart: now - (config.hoursBack || 4) * 3600,
      ...overrides
    })
  };
}

test('entity matching prefers the longest alias and avoids substring false positives', async () => {
  const config = await loadJson('config/buzz.json');
  const registry = buildRegistry(config.entities);

  const claudeCode = scanMentions('Claude Code shipped a fix today', registry);
  assert.equal(claudeCode.get('Claude Code'), 1);
  assert.equal(claudeCode.get('Claude'), undefined, '"claude code" must not double-count as Claude');

  const grokking = scanMentions('Grokking transformers is hard', registry);
  assert.equal(grokking.get('Grok'), undefined, '"grokking" must not match Grok');

  const grok = scanMentions('Grok 4 is fast', registry);
  assert.equal(grok.get('Grok'), 1);

  const llamaCpp = scanMentions('llama.cpp added a new backend', registry);
  assert.equal(llamaCpp.get('llama.cpp'), 1);
  assert.equal(llamaCpp.get('Llama'), undefined);
});

test('sentiment lexicon handles slang and negation', () => {
  assert.ok(scoreText('opus got nerfed again').score < 0);
  assert.ok(scoreText('this model is amazing and worth it').score > 0);
  assert.ok(
    scoreText('honestly not worth it').score < 0,
    'negated positive should read as negative'
  );
  assert.ok(scoreText('no bugs at all').score > 0, 'negated negative should read as positive');
  assert.equal(labelFor(5), 'positive');
  assert.equal(labelFor(-5), 'negative');
  assert.equal(labelFor(1), 'mixed');
  assert.equal(labelFor(0), 'neutral');
  assert.equal(
    labelFor(0, { positives: ['great'], negatives: ['nerfed'] }),
    'divided',
    'praise + complaints that cancel out is divided, not neutral'
  );
  assert.match(describeSentiment({ score: 4, positives: ['great'] }), /positive/);
});

test('analyzeBuzz ranks the most-discussed AI first and attaches evidence', async () => {
  const { result } = await analyzeFixture();

  assert.ok(result.entities.length >= 3, 'at least three entities detected');
  assert.equal(result.entities[0].name, 'Claude Code');

  const names = result.entities.map(e => e.name);
  assert.ok(names.includes('OpenAI Codex'), `expected Codex in ${names.join(', ')}`);
  assert.ok(names.includes('Cursor'), `expected Cursor in ${names.join(', ')}`);
  assert.ok(!names.includes('Grok'), '"grokking" post must not produce a Grok entity');

  const claudeCode = result.entities.find(e => e.name === 'Claude Code');
  assert.deepEqual(claudeCode.subreddits.sort(), ['ClaudeAI', 'ClaudeCode']);
  assert.ok(claudeCode.evidence.length > 0);
  assert.ok(claudeCode.evidence.every(ev => ev.permalink.startsWith('https://')));
  assert.ok(claudeCode.mentions >= 4);

  // Both praise and complaints exist for Claude Code -> reported as divided, not neutral.
  assert.ok(claudeCode.sentiment.positives.length > 0);
  assert.ok(claudeCode.sentiment.negatives.length > 0);
  assert.equal(claudeCode.sentiment.label, 'divided');

  // Codex chatter in the fixture is positive.
  const codex = result.entities.find(e => e.name === 'OpenAI Codex');
  assert.ok(codex.sentiment.score > 0, 'Codex sentiment should be positive');

  // Entities under the mention threshold are dropped.
  assert.ok(result.entities.every(e => e.mentions >= (result.minMentions ?? 2)));
});

test('title mentions outweigh body mentions', async () => {
  const config = await loadJson('config/buzz.json');
  const now = 2000;
  const base = {
    source: 'reddit',
    score: 10,
    numComments: 10,
    created: 1900,
    comments: []
  };
  const posts = [
    { ...base, id: 'a', title: 'Cursor Cursor', selftext: '', subreddit: 's1', permalink: 'https://x/a' },
    { ...base, id: 'b', title: 'update', selftext: 'Ollama Ollama', subreddit: 's1', permalink: 'https://x/b' }
  ];
  const result = analyzeBuzz(posts, {
    ...config,
    now,
    windowStart: now - 4 * 3600,
    weights: { ...config.weights, spread: 0 }
  });
  const cursor = result.entities.find(e => e.name === 'Cursor');
  const ollama = result.entities.find(e => e.name === 'Ollama');
  assert.ok(cursor.buzzScore > ollama.buzzScore, 'title mentions should rank higher');
});

test('renderer produces a buzz block and embeds it in the digest', async () => {
  const { result, config } = await analyzeFixture();
  const topN = config.topN || 3;
  const withTop = { ...result, top: result.entities.slice(0, topN) };

  const section = withTop.top
    .map((e, i) => `${i + 1}. **${e.name}** — ${e.mentions} mentions`)
    .join('\n');

  const block = buildBuzzSection({ result: withTop, section });
  assert.match(block, /## 🔥 AI Buzz — last \d+h/);
  assert.match(block, /posts analyzed across \d+ subreddits/);
  assert.match(block, /Claude Code/);

  const digest = buildDigest({
    date: '2026-07-31',
    sections: [{ topic: 'AI Coding Tools', section: '- **[t](https://x)** — y. (r/codex)' }],
    buzz: block,
    stats: { collected: 10, kept: 3, topics: 1, originCounts: { 'r/codex': 3 } }
  });

  assert.ok(digest.indexOf('AI Buzz') < digest.indexOf('## AI Coding Tools'), 'buzz sits on top');

  // Digest without buzz must remain unchanged in shape.
  const noBuzz = buildDigest({
    date: '2026-07-31',
    sections: [{ topic: 'AI Coding Tools', section: 'x' }],
    stats: { collected: 1, kept: 1, topics: 1, originCounts: {} }
  });
  assert.ok(!noBuzz.includes('AI Buzz'));
});

test('per-post mention caps stop one ranty post from dominating', async () => {
  const config = await loadJson('config/buzz.json');
  const now = 2000;
  const base = { source: 'reddit', score: 0, numComments: 0, created: 1900, comments: [] };
  const posts = [
    {
      ...base,
      id: 'rant',
      title: 'Cursor',
      selftext: 'Cursor '.repeat(30),
      subreddit: 's1',
      permalink: 'https://x/rant'
    },
    { ...base, id: 'o1', title: 'Ollama', selftext: 'Ollama', subreddit: 's1', permalink: 'https://x/o1' },
    { ...base, id: 'o2', title: 'Ollama', selftext: 'Ollama', subreddit: 's1', permalink: 'https://x/o2' },
    { ...base, id: 'o3', title: 'Ollama', selftext: 'Ollama', subreddit: 's1', permalink: 'https://x/o3' }
  ];
  const result = analyzeBuzz(posts, { ...config, now, windowStart: now - 4 * 3600 });
  const cursor = result.entities.find(e => e.name === 'Cursor');
  const ollama = result.entities.find(e => e.name === 'Ollama');

  assert.ok(cursor.mentions <= 5, `capped mentions, got ${cursor.mentions}`);
  assert.ok(ollama.buzzScore > cursor.buzzScore, 'three posts should beat one repetitive post');
});

test('summarizeBuzz falls back to a linked list when Gemini is unavailable', async t => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  });

  const { result, config } = await analyzeFixture();
  const withTop = { ...result, top: result.entities.slice(0, config.topN || 3) };

  const section = await summarizeBuzz(withTop);
  assert.match(section, /^1\. \*\*Claude Code\*\* —/m);
  assert.match(section, /\[.+\]\(https:\/\/www\.reddit\.com/);
  assert.equal(await summarizeBuzz({ top: [] }), '', 'no entities -> empty section');
});

test('parseCommentListing walks nested replies and drops deleted comments', () => {
  const json = [
    { kind: 'Listing', data: { children: [{ kind: 't3', data: { title: 'post' } }] } },
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't1',
            data: {
              body: 'top level opinion',
              score: 12,
              replies: {
                data: {
                  children: [
                    { kind: 't1', data: { body: 'nested reply', score: 3, replies: '' } },
                    { kind: 't1', data: { body: '[deleted]', score: 0, replies: '' } }
                  ]
                }
              }
            }
          },
          { kind: 'more', data: { count: 40 } },
          { kind: 't1', data: { body: 'second opinion', score: 5, replies: '' } }
        ]
      }
    }
  ];

  const comments = parseCommentListing(json, 10);
  assert.deepEqual(
    comments.map(c => c.body),
    ['top level opinion', 'nested reply', 'second opinion']
  );
  assert.equal(comments[0].score, 12);
  assert.equal(parseCommentListing(json, 2).length, 2, 'respects the limit');
  assert.deepEqual(parseCommentListing(null, 5), []);
});

test('partial subreddit coverage is disclosed in the report', () => {
  const block = buildBuzzSection({
    result: {
      hoursBack: 4,
      totalPosts: 12,
      subreddits: ['ClaudeCode'],
      entities: [],
      top: [],
      coverage: { covered: ['ClaudeCode'], failed: ['OpenAI', 'codex'], requested: 3 }
    },
    section: ''
  });
  assert.match(block, /rate-limited.*r\/OpenAI, r\/codex/);
});

test('buzz markdown converts to Notion numbered-list blocks with links', () => {
  const md = [
    '## 🔥 AI Buzz — last 4h',
    '',
    '1. **Claude Code** — 37 mentions · 2 subreddits · mixed (-5)',
    '   - **Why:** people are hitting usage limits.',
    '   - **Evidence:** [post](https://www.reddit.com/r/ClaudeCode/comments/b2/x/)',
    '2. **Codex** — 21 mentions · 3 subreddits · mostly positive (+8)',
    '   - **Why:** long-running task reliability.',
    '3. **Gemini** — 12 mentions · 1 subreddit · neutral',
    '',
    '**Also mentioned:** Cursor (4)'
  ].join('\n');

  const blocks = markdownToNotionBlocks(md);
  assert.equal(blocks[0].type, 'heading_2');

  // The three ranked entries must stay contiguous siblings, otherwise Notion
  // restarts the numbering at "1." for every entry.
  const ranked = blocks.filter(b => b.type === 'numbered_list_item');
  assert.equal(ranked.length, 3);
  const firstIdx = blocks.indexOf(ranked[0]);
  assert.deepEqual(
    blocks.slice(firstIdx, firstIdx + 3).map(b => b.type),
    ['numbered_list_item', 'numbered_list_item', 'numbered_list_item'],
    'nothing may be interleaved between ranked entries'
  );
  assert.ok(
    !blocks.some(b => b.type === 'bulleted_list_item'),
    'detail lines belong to their entry, not the top level'
  );

  const children = ranked[0].numbered_list_item.children;
  assert.equal(children.length, 2);
  assert.ok(children.every(c => c.type === 'bulleted_list_item'));

  const evidence = children.find(c =>
    c.bulleted_list_item.rich_text.some(t => t.text.link)
  );
  assert.ok(evidence, 'evidence link survives the Notion conversion');
  assert.match(
    evidence.bulleted_list_item.rich_text.find(t => t.text.link).text.link.url,
    /reddit\.com/
  );

  assert.equal(ranked[2].numbered_list_item.children, undefined, 'no empty children array');
  assert.equal(blocks.at(-1).type, 'paragraph', '"Also mentioned" closes the list');
});

test('list nesting never exceeds the depth Notion accepts on create', () => {
  const md = [
    '- level one',
    '  - level two',
    '    - level three',
    '      - level four'
  ].join('\n');

  const blocks = markdownToNotionBlocks(md);
  assert.equal(blocks.length, 1);

  const depthOf = (block, d = 1) => {
    const children = block[block.type].children || [];
    return children.length === 0 ? d : Math.max(...children.map(c => depthOf(c, d + 1)));
  };
  assert.equal(depthOf(blocks[0]), 2, 'deeper markdown levels collapse onto the parent');

  // Nothing is dropped — the deeper items are flattened, not discarded.
  const texts = blocks[0].bulleted_list_item.children.map(c =>
    c.bulleted_list_item.rich_text.map(t => t.text.content).join('')
  );
  assert.deepEqual(texts, ['level two', 'level three', 'level four']);
});

test('the published digest payload satisfies Notion API constraints', async t => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY; // keep the test offline and deterministic
  t.after(() => {
    if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
  });

  const { result, config } = await analyzeFixture();
  const withTop = { ...result, top: result.entities.slice(0, config.topN || 3) };
  const section = await summarizeBuzz(withTop); // no API key -> fallback

  const markdown = buildDigest({
    date: '2026-08-01',
    sections: [
      {
        topic: 'AI Coding Tools',
        section: '- **[A tool](https://example.com/a)** — why it matters. (r/codex)'
      }
    ],
    buzz: buildBuzzSection({ result: withTop, section }),
    stats: { collected: 100, kept: 16, topics: 1, originCounts: { 'r/codex': 16 } }
  });

  const blocks = markdownToNotionBlocks(markdown);

  const check = (block, depth) => {
    assert.equal(block.object, 'block');
    assert.ok(block.type && block[block.type], `block payload keyed by type: ${block.type}`);
    assert.ok(depth <= 2, `nesting depth ${depth} exceeds what Notion accepts on create`);

    const body = block[block.type];
    const richText = body.rich_text || [];
    assert.ok(richText.length <= 100, 'rich_text arrays stay under the 100-element cap');
    for (const t of richText) {
      assert.ok(t.text.content.length <= 2000, 'rich_text content stays under 2000 chars');
      if (t.text.link) assert.match(t.text.link.url, /^https?:\/\//);
    }
    for (const child of body.children || []) check(child, depth + 1);
  };

  for (const block of blocks) check(block, 1);

  // createDigestPage() sends the first 100 top-level blocks, then appends the rest.
  for (let i = 0; i < blocks.length; i += 100) {
    assert.ok(blocks.slice(i, i + 100).length <= 100);
  }

  // The buzz section must actually be present in what gets published.
  const flat = JSON.stringify(blocks);
  assert.match(flat, /AI Buzz/, 'buzz heading reaches Notion');
  assert.match(flat, /Claude Code/, 'buzz ranking reaches Notion');
  assert.ok(
    blocks.filter(b => b.type === 'numbered_list_item').length >= 3,
    'all ranked entries reach Notion as siblings'
  );
});

test('empty buzz result renders a graceful message', () => {
  const block = buildBuzzSection({
    result: { hoursBack: 4, totalPosts: 0, subreddits: [], entities: [], top: [] },
    section: ''
  });
  assert.match(block, /No clear AI stood out/);
});
