/**
 * render-markdown.js — assemble the final digest and save it locally.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** YYYY-MM-DD in the configured timezone. */
export function digestDate(timezone) {
  const tz = timezone || process.env.DIGEST_TIMEZONE || 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/**
 * Build the full Markdown digest.
 * @param {object} opts
 * @param {string} opts.date - YYYY-MM-DD
 * @param {Array<{topic, section}>} opts.sections
 * @param {object} opts.stats - { collected, kept, topics }
 * @returns {string} markdown
 */
export function buildDigest({ date, sections, stats }) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');
  const lines = [];
  lines.push(isKorean ? `# 🤖 데일리 AI 시그널 — ${date}` : `# 🤖 Daily AI Signal — ${date}`);
  lines.push('');

  // Source breakdown line.
  const origins = stats.originCounts || {};
  const originList = Object.entries(origins)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} (${n})`)
    .join(' · ');
  lines.push(
    isKorean
      ? `> 수집: ${stats.collected} | 선정: ${stats.kept} | 토픽: ${stats.topics}`
      : `> Collected: ${stats.collected} | Selected: ${stats.kept} | Topics: ${stats.topics}`
  );
  if (originList) {
    lines.push(isKorean ? `> 출처: ${originList}` : `> Sources: ${originList}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  if (sections.length === 0) {
    lines.push(
      isKorean
        ? '_오늘은 설정한 토픽에 맞는 고신호 포스트가 없습니다._'
        : '_No high-signal posts matched your topics today._'
    );
    lines.push('');
    return lines.join('\n');
  }

  for (const { topic, section } of sections) {
    lines.push(`## ${topic}`);
    lines.push('');
    lines.push(section.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write the digest to output/<date>.md.
 * @returns {Promise<string>} absolute file path
 */
export async function saveDigest(markdown, date, baseDir) {
  const outputDir = join(baseDir, 'output');
  await mkdir(outputDir, { recursive: true });
  const filepath = join(outputDir, `${date}.md`);
  await writeFile(filepath, markdown, 'utf-8');
  console.log(`[output] saved ${filepath}`);
  return filepath;
}
