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
 * Build the "Artificial Analysis" section: articles published since the last run.
 *
 * @param {object} opts
 * @param {object} opts.result - findNewArticles() output
 * @param {string} opts.section - markdown list (from summarizeArticles)
 * @param {boolean} [opts.includeHeading=true]
 * @returns {string} markdown ('' when the monitor produced nothing at all)
 */
export function buildArticlesSection({ result, section, includeHeading = true }) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');
  if (!result) return '';

  const lines = [];
  const label = result.source || 'Artificial Analysis';

  if (includeHeading) {
    lines.push(isKorean ? `## 📊 ${label} — 새 글` : `## 📊 ${label} — New Articles`);
    lines.push('');
  }

  // Silence is ambiguous (nothing new vs. monitor broken), so always say which.
  if (!result.articles?.length) {
    const days = result.lookbackDays ?? 1;
    lines.push(
      isKorean
        ? `_최근 ${days}일간 [새 글](${result.url})이 없습니다._`
        : `_No new articles in the last ${days} day${days === 1 ? '' : 's'} ([index](${result.url}))._`
    );
    lines.push('');
    return lines.join('\n');
  }

  const dates = result.articles.map(a => a.published).filter(Boolean);
  const range =
    dates.length > 1 && dates.at(-1) !== dates[0]
      ? `${dates.at(-1)} → ${dates[0]}`
      : dates[0] || '';
  lines.push(
    isKorean
      ? `> 새 글 ${result.articles.length}개${range ? ` · ${range}` : ''}`
      : `> ${result.articles.length} new article${result.articles.length === 1 ? '' : 's'}${range ? ` · ${range}` : ''}`
  );

  if (result.failed?.length) {
    lines.push(
      isKorean
        ? `> ⚠️ 확인 실패: ${result.failed.length}건`
        : `> ⚠️ ${result.failed.length} article page(s) could not be read this run`
    );
  }
  lines.push('');

  lines.push((section || '').trim() || buildArticleFallbackList(result.articles));
  lines.push('');

  return lines.join('\n');
}

function buildArticleFallbackList(articles) {
  return articles.map(a => `- **[${a.title}](${a.url})**`).join('\n');
}

/**
 * Build the full Markdown digest.
 * @param {object} opts
 * @param {string} opts.date - YYYY-MM-DD
 * @param {Array<{topic, section}>} opts.sections
 * @param {object} opts.stats - { collected, kept, topics }
 * @param {string} [opts.lead] - optional rendered block placed above the topics
 *   (currently the Artificial Analysis articles section)
 * @returns {string} markdown
 */
export function buildDigest({ date, sections, stats, lead }) {
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

  if (lead) {
    lines.push(lead.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

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
