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

/** Local time as HHMM in the configured timezone (used for research filenames). */
export function digestTime(timezone) {
  const tz = timezone || process.env.DIGEST_TIMEZONE || 'UTC';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date())
    .replace(':', '');
}

/**
 * Build the "AI Buzz" research block: what people are talking about right now.
 *
 * @param {object} opts
 * @param {object} opts.result - runBuzz() output
 * @param {string} opts.section - markdown list (from summarizeBuzz)
 * @param {boolean} [opts.includeHeading=true]
 * @returns {string} markdown (empty string when there is nothing to report)
 */
export function buildBuzzSection({ result, section, includeHeading = true }) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');
  if (!result) return '';

  const subs = (result.subreddits || []).map(s => `r/${s}`).join(' · ');
  const lines = [];

  if (includeHeading) {
    lines.push(
      isKorean
        ? `## 🔥 AI 화제 — 최근 ${result.hoursBack}시간`
        : `## 🔥 AI Buzz — last ${result.hoursBack}h`
    );
    lines.push('');
  }

  lines.push(
    isKorean
      ? `> 분석한 포스트 ${result.totalPosts}개 · 서브레딧 ${result.subreddits?.length || 0}개`
      : `> ${result.totalPosts} posts analyzed across ${result.subreddits?.length || 0} subreddits`
  );
  if (subs) lines.push(`> ${subs}`);

  // Anonymous Reddit access gets throttled, so be explicit when coverage is partial.
  const failed = result.coverage?.failed || [];
  if (failed.length > 0) {
    const list = failed.map(s => `r/${s}`).join(', ');
    lines.push(
      isKorean
        ? `> ⚠️ 수집 실패(레이트 리밋): ${list}`
        : `> ⚠️ Not reachable this run (rate-limited): ${list}`
    );
  }
  lines.push('');

  if (!section || !result.top?.length) {
    lines.push(
      isKorean
        ? `_최근 ${result.hoursBack}시간 동안 뚜렷하게 화제가 된 AI가 없습니다._`
        : `_No clear AI stood out in the last ${result.hoursBack}h._`
    );
    lines.push('');
    return lines.join('\n');
  }

  lines.push(section.trim());
  lines.push('');

  // "Also mentioned" tail: everything ranked below the top N.
  const rest = (result.entities || []).slice(result.top.length, result.top.length + 6);
  if (rest.length > 0) {
    const tail = rest.map(e => `${e.name} (${e.mentions})`).join(' · ');
    lines.push(isKorean ? `**그 외 언급:** ${tail}` : `**Also mentioned:** ${tail}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build the full Markdown digest.
 * @param {object} opts
 * @param {string} opts.date - YYYY-MM-DD
 * @param {Array<{topic, section}>} opts.sections
 * @param {object} opts.stats - { collected, kept, topics }
 * @param {string} [opts.buzz] - optional rendered buzz block (placed near the top)
 * @returns {string} markdown
 */
export function buildDigest({ date, sections, stats, buzz }) {
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

  if (buzz) {
    lines.push(buzz.trim());
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

/**
 * Write a standalone research report to output/research/<date>-<HHMM>-<name>.md.
 * @returns {Promise<string>} absolute file path
 */
export async function saveResearch(markdown, baseDir, name = 'buzz') {
  const outputDir = join(baseDir, 'output', 'research');
  await mkdir(outputDir, { recursive: true });
  const filepath = join(outputDir, `${digestDate()}-${digestTime()}-${name}.md`);
  await writeFile(filepath, markdown, 'utf-8');
  console.log(`[output] saved ${filepath}`);
  return filepath;
}
