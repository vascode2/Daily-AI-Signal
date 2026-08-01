/**
 * test/pipeline.test.js — integration test: X fixture -> filter -> groups.
 *
 * Verifies X posts flow through the shared pipeline contract and land in the
 * expected topic groups. Does NOT call Gemini (kept offline/deterministic);
 * the live AI path is exercised by scripts/e2e-x.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { collect } from '../src/collectors/x.js';
import { filterAndGroup } from '../src/filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

test('X fixture posts flow through filterAndGroup into topics', async () => {
  const topicsConfig = JSON.parse(
    await readFile(join(ROOT, 'config/topics.json'), 'utf-8')
  );

  const posts = await collect({
    enabled: true,
    mode: 'fixture',
    fixturePath: 'test/fixtures/x-sample.json',
    minScore: 3,
    hoursBack: 0
  });
  assert.ok(posts.length > 0, 'fixture produced posts');

  const groups = filterAndGroup(posts, topicsConfig);
  assert.ok(groups.length > 0, 'at least one topic group formed');

  // Every grouped post should be an X post with a valid origin tag for the prompt.
  const grouped = groups.flatMap(g => g.posts);
  assert.ok(grouped.length > 0);
  for (const p of grouped) {
    assert.equal(p.source, 'x');
    assert.match(p.origin, /^X\/@/);
    assert.ok(Array.isArray(p.topics) && p.topics.length > 0);
  }

  // Sanity: the "Local LLMs" topic should be represented by the fixture.
  const topicNames = groups.map(g => g.topic);
  assert.ok(
    topicNames.includes('Local LLMs') || topicNames.includes('AI Coding Tools'),
    `expected known topics, got: ${topicNames.join(', ')}`
  );
});

/**
 * Reddit's public RSS feed reports no score or comment count, so those posts
 * arrive with zeros. Ranking must treat that as "unknown", not "unpopular",
 * otherwise sources with real metrics (Hacker News) win every slot.
 */
test('posts without engagement metrics are not buried under scored posts', () => {
  const topicsConfig = {
    maxPostsPerTopic: 5,
    topics: [{ name: 'AI Coding Tools', keywords: ['claude code'] }]
  };

  const redditPost = {
    source: 'reddit',
    id: 'reddit:1',
    title: 'I built a Claude Code workflow that reviews my PRs',
    url: 'https://reddit.com/1',
    permalink: 'https://reddit.com/1',
    score: 0,
    numComments: 0,
    metricsKnown: false,
    origin: 'r/ClaudeCode',
    author: 'a',
    selftext: '',
    created: 0
  };
  // A deliberately weak HN post: it clears the point floor but says nothing useful.
  const hnPost = {
    source: 'hackernews',
    id: 'hn:1',
    title: 'Claude Code discussion thread',
    url: 'https://news.ycombinator.com/1',
    permalink: 'https://news.ycombinator.com/1',
    score: 40,
    numComments: 20,
    metricsKnown: true,
    origin: 'Hacker News',
    author: 'b',
    selftext: '',
    created: 0
  };

  const groups = filterAndGroup([redditPost, hnPost], topicsConfig);
  const picked = groups[0].posts;
  assert.equal(picked.length, 2, 'both posts match the topic');
  assert.equal(
    picked[0].source,
    'reddit',
    'the unscored post wins on content ("i built") instead of losing on missing metrics'
  );

  // The median stand-in must be derived from the scored posts, not hardcoded.
  assert.ok(
    picked.find(p => p.source === 'reddit').usefulness > 0,
    'unscored posts get a real popularity baseline'
  );
});

test('an unscored post still loses to a genuinely popular one', () => {
  const topicsConfig = {
    maxPostsPerTopic: 20,
    topics: [{ name: 'AI Coding Tools', keywords: ['claude code'] }]
  };

  const base = {
    url: 'https://x/1', permalink: 'https://x/1', author: 'a', selftext: '', created: 0
  };
  // A realistic spread of scored posts, so the median stand-in sits mid-pack.
  const scored = [30, 45, 60, 80, 120, 200, 350, 900, 4000].map((score, i) => ({
    ...base,
    source: 'hackernews',
    id: `h${i}`,
    title: 'Claude Code question',
    score,
    numComments: Math.round(score / 4),
    metricsKnown: true,
    origin: 'Hacker News'
  }));
  const unscored = {
    ...base,
    source: 'reddit',
    id: 'r1',
    title: 'Claude Code question',
    score: 0,
    numComments: 0,
    metricsKnown: false,
    origin: 'r/ClaudeCode'
  };

  const picked = filterAndGroup([unscored, ...scored], topicsConfig)[0].posts;
  const rankOf = id => picked.findIndex(p => p.id === id);

  assert.ok(
    rankOf('h8') < rankOf('r1'),
    'the 4000-point post outranks the unknown-metrics baseline'
  );
  assert.ok(
    rankOf('r1') < rankOf('h0'),
    'the baseline still outranks the weakest scored post, instead of sinking below all of them'
  );
});

/**
 * Reddit contributes far more posts than Hacker News and, being self-posts,
 * earns content bonuses that HN link-posts cannot. Selection must not let the
 * higher-volume source take every slot.
 */
test('a high-volume source cannot crowd out a low-volume one', () => {
  const topicsConfig = {
    maxPostsPerTopic: 10,
    topics: [{ name: 'AI Coding Tools', keywords: ['agent'] }]
  };

  const bulky = Array.from({ length: 100 }, (_, i) => ({
    source: 'reddit',
    id: `r${i}`,
    title: 'I built an agent workflow',
    url: `https://reddit.com/${i}`,
    permalink: `https://reddit.com/${i}`,
    score: 0,
    numComments: 0,
    metricsKnown: false,
    origin: 'r/ClaudeCode',
    author: 'a',
    selftext: 'x'.repeat(400),
    created: 0
  }));
  const scarce = Array.from({ length: 10 }, (_, i) => ({
    source: 'hackernews',
    id: `h${i}`,
    title: 'agent framework release',
    url: `https://news.ycombinator.com/${i}`,
    permalink: `https://news.ycombinator.com/${i}`,
    score: 50 + i * 30,
    numComments: 20 + i * 10,
    metricsKnown: true,
    origin: 'Hacker News',
    author: 'b',
    selftext: '',
    created: 0
  }));

  const picked = filterAndGroup([...bulky, ...scarce], topicsConfig)[0].posts;
  const counts = picked.reduce((m, p) => ({ ...m, [p.source]: (m[p.source] || 0) + 1 }), {});

  assert.equal(picked.length, 10);
  assert.ok(
    counts.hackernews >= 4,
    `the smaller source keeps a fair share, got ${JSON.stringify(counts)}`
  );
  assert.ok(
    counts.reddit >= 4,
    `the larger source is still well represented, got ${JSON.stringify(counts)}`
  );
});
