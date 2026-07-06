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
