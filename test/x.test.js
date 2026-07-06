/**
 * test/x.test.js — unit tests for the X.com collector.
 *
 * Uses Node's built-in test runner (node:test) — no extra dependencies.
 * Run with: `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collect, __test__ } from '../src/collectors/x.js';

const { buildApiQuery, normalizeXPost, mapRawRows, applyGates, compactText, toEpochSeconds } =
  __test__;

test('buildApiQuery combines accounts, keywords, and filters', () => {
  const q = buildApiQuery({
    accounts: ['@OpenAI', 'ollama'],
    keywords: ['local llm', 'ai agent'],
    lang: 'en'
  });
  assert.ok(q.includes('from:OpenAI'), 'strips @ and adds from:');
  assert.ok(q.includes('from:ollama'));
  assert.ok(q.includes('"local llm"'));
  assert.ok(q.includes('-is:retweet'));
  assert.ok(q.includes('-is:reply'));
  assert.ok(q.includes('lang:en'));
});

test('buildApiQuery omits lang filter when not provided', () => {
  const q = buildApiQuery({ accounts: ['a'], keywords: [] });
  assert.ok(!q.includes('lang:'), 'no lang filter without config.lang');
});

test('buildApiQuery is empty when no accounts and no keywords', () => {
  const q = buildApiQuery({ accounts: [], keywords: [] });
  // Only the retweet/reply filters remain; there is no user/keyword scope.
  assert.ok(!q.includes('from:'));
  assert.ok(!q.includes('"'));
});

test('normalizeXPost produces the normalized post contract', () => {
  const p = normalizeXPost({
    id: '123',
    text: 'Hello   world &amp; friends',
    username: 'OpenAI',
    authorId: '444',
    createdAt: '2026-07-06T09:00:00.000Z',
    metrics: { like_count: 100, retweet_count: 10, quote_count: 5, reply_count: 20 }
  });
  assert.equal(p.source, 'x');
  assert.equal(p.id, 'x:123');
  assert.equal(p.permalink, 'https://x.com/OpenAI/status/123');
  assert.equal(p.url, p.permalink);
  assert.equal(p.subreddit, 'X');
  assert.equal(p.origin, 'X/@OpenAI');
  assert.equal(p.author, 'OpenAI');
  assert.equal(p.numComments, 20);
  // score = like + repost*2 + quote*2 = 100 + 20 + 10 = 130
  assert.equal(p.score, 130);
  // entity decoded + whitespace collapsed
  assert.equal(p.selftext, 'Hello world & friends');
  assert.ok(p.created > 0);
});

test('normalizeXPost falls back to web permalink without username', () => {
  const p = normalizeXPost({ id: '999', text: 'x', authorId: '1', metrics: {} });
  assert.equal(p.permalink, 'https://x.com/i/web/status/999');
  assert.equal(p.author, '1');
});

test('mapRawRows accepts flexible scraper field names and drops empties', () => {
  const rows = [
    { id: '1', text: 'a post', username: 'u', createdAt: '2026-07-06T00:00:00Z', likeCount: 5 },
    { id: '2', text: 'snake case', username: 'u2', created_at: '2026-07-06T00:00:00Z', like_count: 9 },
    { id: '3', text: '', username: 'u3' } // empty text -> dropped (no title)
  ];
  const posts = mapRawRows(rows);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].id, 'x:1');
  assert.equal(posts[1].id, 'x:2');
});

test('toEpochSeconds handles ISO, epoch seconds, epoch millis, and junk', () => {
  assert.equal(toEpochSeconds('2026-07-06T00:00:00.000Z'), 1783296000);
  assert.equal(toEpochSeconds(1783296000), 1783296000); // seconds
  assert.equal(toEpochSeconds(1783296000000), 1783296000); // millis
  assert.equal(toEpochSeconds('not a date'), 0);
});

test('compactText decodes entities, collapses whitespace, and truncates', () => {
  assert.equal(compactText('a\n\n  b   c'), 'a b c');
  assert.equal(compactText('&lt;tag&gt;'), '<tag>');
  assert.equal(compactText('abcdef', 3), 'abc');
});

test('applyGates drops low-score and out-of-window posts', () => {
  const now = Math.floor(Date.now() / 1000);
  const posts = [
    { id: 'x:1', score: 100, created: now - 3600 }, // recent, high score
    { id: 'x:2', score: 1, created: now - 3600 }, // recent, low score
    { id: 'x:3', score: 100, created: now - 48 * 3600 } // old, high score
  ];
  const kept = applyGates(posts, { minScore: 3, hoursBack: 24 });
  assert.deepEqual(
    kept.map(p => p.id),
    ['x:1']
  );
});

test('applyGates keeps everything when gates disabled', () => {
  const posts = [
    { id: 'x:1', score: 0, created: 0 },
    { id: 'x:2', score: 0, created: 1 }
  ];
  const kept = applyGates(posts, { minScore: 0, hoursBack: 0 });
  assert.equal(kept.length, 2);
});

test('applyGates filters by known language but keeps unknown-lang posts', () => {
  const posts = [
    { id: 'x:1', score: 10, created: 0, lang: 'en' },
    { id: 'x:2', score: 10, created: 0, lang: 'ja' },
    { id: 'x:3', score: 10, created: 0, lang: '' } // unknown -> kept
  ];
  const kept = applyGates(posts, { lang: 'en' });
  assert.deepEqual(
    kept.map(p => p.id),
    ['x:1', 'x:3']
  );
});

test('collect() returns [] when disabled', async () => {
  const posts = await collect({ enabled: false, mode: 'fixture' });
  assert.deepEqual(posts, []);
});

test('collect() fixture mode loads, normalizes, de-dupes, and gates', async () => {
  const posts = await collect({
    enabled: true,
    mode: 'fixture',
    fixturePath: 'test/fixtures/x-sample.json',
    minScore: 3,
    hoursBack: 0 // disable time window so the static fixture is stable over time
  });
  assert.ok(posts.length >= 4, `expected several posts, got ${posts.length}`);
  // Every post must satisfy the normalized contract used by the pipeline.
  for (const p of posts) {
    assert.equal(p.source, 'x');
    assert.match(p.id, /^x:/);
    assert.ok(p.title.length > 0);
    assert.match(p.permalink, /^https:\/\/x\.com\//);
    assert.equal(p.subreddit, 'X');
    assert.match(p.origin, /^X\/@/);
  }
  // The low-engagement "gm" post (score below minScore) must be filtered out.
  assert.ok(!posts.some(p => p.selftext === 'gm'), 'low-score post should be gated');
  // No duplicate ids.
  const ids = posts.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('collect() fixture mode enforces maxResults cap (highest-signal first)', async () => {
  const posts = await collect({
    enabled: true,
    mode: 'fixture',
    fixturePath: 'test/fixtures/x-sample.json',
    minScore: 0,
    hoursBack: 0,
    maxResults: 2
  });
  assert.equal(posts.length, 2, 'cap applied');
  // Results are sorted by score desc, so the cap keeps the top-scoring posts.
  assert.ok(posts[0].score >= posts[1].score, 'sorted by score descending');
});
