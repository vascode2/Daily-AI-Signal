/**
 * summarize.js — Gemini summarization for each topic group.
 *
 * Mirrors the raw-HTTP Gemini pattern used in the sibling digest projects:
 * no SDK, a primary model plus a fallback chain (on 404/429), and a simple
 * response-text extractor. If no API key is set, it degrades gracefully to a
 * non-AI fallback so the pipeline still produces a digest.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

function getModels() {
  const primary = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  const fallbacks = (process.env.GEMINI_MODEL_FALLBACKS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return [...new Set([primary, ...fallbacks])];
}

function extractText(data) {
  return (data?.candidates || [])
    .flatMap(c => c.content?.parts || [])
    .map(p => p.text || '')
    .join('\n')
    .trim();
}

async function callGemini(model, prompt, apiKey, timeoutMs) {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, topP: 0.9 }
    })
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Gemini ${model} failed (${res.status}): ${body.slice(0, 300)}`);
    err.status = res.status;
    err.retryAfter = parseFloat(res.headers.get('retry-after') || '0');
    throw err;
  }
  return extractText(await res.json());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Gemini sometimes emits near-valid links like `[title] (https://...)`.
 * Normalize them to strict markdown `[title](https://...)` so downstream
 * Notion conversion preserves clickable links.
 */
function normalizeMarkdownLinks(text) {
  if (!text) return text;
  return text
    .replace(/\[([^\]]+)\]\s+\((https?:\/\/[^)]+)\)/g, '[$1]($2)')
    .replace(/\*\*\[([^\]]+)\]\s+\((https?:\/\/[^)]+)\)\*\*/g, '**[$1]($2)**')
    .replace(/\[([^\]]+)\]\s*\n\s*\((https?:\/\/[^)]+)\)/g, '[$1]($2)')
    .replace(/\*\*\[([^\]]+)\]\s*\n\s*\((https?:\/\/[^)]+)\)\*\*/g, '**[$1]($2)**');
}

/**
 * Try each model in order. For a 429 (quota), honor Retry-After and retry the
 * same model once before moving on. Advance to the next model on 404/5xx.
 */
async function generateWithFallback(prompt, apiKey, timeoutMs) {
  const models = getModels();
  let lastErr;
  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await callGemini(model, prompt, apiKey, timeoutMs);
        if (text) return text;
        break; // empty text — try next model
      } catch (err) {
        lastErr = err;
        if (err.status === 429 && attempt === 1) {
          const wait = Math.min((err.retryAfter || 8) * 1000, 20000);
          console.warn(`[summarize] ${model} rate-limited (429); waiting ${wait}ms then retrying.`);
          await sleep(wait);
          continue; // retry same model
        }
        if (err.status === 404 || err.status === 429 || err.status >= 500) {
          console.warn(`[summarize] ${model} unavailable (${err.status}); trying next model.`);
          break; // next model
        }
        throw err;
      }
    }
  }
  throw lastErr || new Error('All Gemini models failed');
}

function buildPrompt(topic, posts) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');
  const list = posts
    .map((p, i) => {
      const body = p.selftext ? `\n   Body: ${p.selftext.slice(0, 400)}` : '';
      const origin = p.origin || `r/${p.subreddit}`;
      const engagement = p.score > 0 ? `, ${p.score} points, ${p.numComments} comments` : '';
      return `${i + 1}. (${origin}${engagement})\n   Title: ${p.title}${body}\n   Link: ${p.permalink}`;
    })
    .join('\n\n');

  return `You are an AI-signal curator writing a daily digest for a technical engineer.
Topic: "${topic}"

Below are posts already filtered to this topic, gathered from multiple sources
(e.g. Reddit, Hacker News, and X/Twitter). Write a concise, high-signal Markdown section.

Rules:
- Start with ONE short sentence (plain text, no heading) summarizing the theme of this topic today.
- Then a Markdown bullet list, one bullet per post, in this exact format:
  - **[<short punchy title>](<link>)** — 1-2 sentences on the key insight and why it is practically useful. (<source>)
- The <source> tag MUST be included at the END of each bullet, exactly as provided (e.g. "r/LocalLLaMA", "Hacker News", "X/@OpenAI").
- Keep it factual and specific. No hype, no filler, no emojis.
- Do NOT add a topic heading (it is added by the renderer).
- Skip low-value posts instead of padding.
- Output language: ${isKorean ? 'Korean (한국어)' : 'English'}.

Posts:
${list}`;
}

function fallbackSection(posts) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');
  const intro = isKorean
    ? 'AI 요약을 생성하지 못해, 이 토픽의 상위 포스트를 표시합니다.'
    : 'AI summary unavailable — showing top posts for this topic.';
  const bullets = posts
    .map(p => {
      const origin = p.origin || `r/${p.subreddit}`;
      const engagement = p.score > 0 ? ` — ${p.score} points, ${p.numComments} comments` : '';
      return `- **[${p.title}](${p.permalink})**${engagement} (${origin})`;
    })
    .join('\n');
  return `${intro}\n\n${bullets}`;
}

/**
 * Build the prompt that explains *why* the top entities are being discussed.
 * The numbers (mentions, sentiment, spread) are computed deterministically in
 * src/research/buzz.js — Gemini only writes the explanation around them.
 */
function buildBuzzPrompt(result) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');

  const blocks = result.top
    .map((e, i) => {
      const evidence = e.evidence
        .map(
          ev =>
            `     - "${ev.title}" (${ev.origin}, ${ev.score} points, ${ev.numComments} comments) ${ev.permalink}`
        )
        .join('\n');
      const quotes = e.quotes.length
        ? `\n   Representative comments:\n${e.quotes.map(q => `     - "${q}"`).join('\n')}`
        : '';
      const cues = [
        e.sentiment.positives.length ? `positive cues: ${e.sentiment.positives.join(', ')}` : '',
        e.sentiment.negatives.length ? `negative cues: ${e.sentiment.negatives.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' | ');

      return `${i + 1}. ${e.name}${e.vendor ? ` (${e.vendor})` : ''}
   Mentions: ${e.mentions} across ${e.postCount} posts in ${e.subreddits.length} subreddits (${e.subreddits
     .map(s => `r/${s}`)
     .join(', ')})
   Buzz score: ${e.buzzScore} | Sentiment: ${e.sentiment.summary}${cues ? ` | ${cues}` : ''}
   Top posts:
${evidence}${quotes}`;
    })
    .join('\n\n');

  return `You are an AI-trend analyst. Below is measured Reddit chatter from the last ${result.hoursBack} hours across ${result.subreddits
    .map(s => `r/${s}`)
    .join(', ')} (${result.totalPosts} posts analyzed).

Explain WHY each of these ${result.top.length} AI tools/models is being talked about right now.

Rules:
- Output ONLY a Markdown ordered list, one item per entity, in this exact shape:
  1. **<entity name>** — <mentions> mentions · <N> subreddits · <sentiment summary>
     - **Why:** 1-2 sentences on the concrete reason it is being discussed right now (a release, a regression, pricing, a comparison, a workflow people found). Base this strictly on the evidence below.
     - **Mood:** one short sentence on how people feel and what specifically drives that feeling.
     - **Evidence:** [<short post title>](<link>) · [<short post title>](<link>)
- Use the exact numbers given. Do not invent facts, versions, or events not supported by the evidence.
- If the evidence is thin, say what the chatter suggests and keep it short. Never pad.
- No headings, no preamble, no emojis.
- Output language: ${isKorean ? 'Korean (한국어)' : 'English'}.

Data:
${blocks}`;
}

function fallbackBuzzSection(result) {
  const lang = (process.env.DIGEST_LANGUAGE || 'en').toLowerCase();
  const isKorean = lang.startsWith('ko');

  return result.top
    .map((e, i) => {
      const subs = e.subreddits.map(s => `r/${s}`).join(', ');
      const evidence = e.evidence
        .slice(0, 2)
        .map(ev => `[${ev.title}](${ev.permalink})`)
        .join(' · ');
      const head = isKorean
        ? `${i + 1}. **${e.name}** — 언급 ${e.mentions}회 · ${e.subreddits.length}개 서브레딧 · ${e.sentiment.summary}`
        : `${i + 1}. **${e.name}** — ${e.mentions} mentions · ${e.subreddits.length} subreddits · ${e.sentiment.summary}`;
      const where = isKorean ? `   - **어디서:** ${subs}` : `   - **Where:** ${subs}`;
      const ev = evidence
        ? isKorean
          ? `   - **근거:** ${evidence}`
          : `   - **Evidence:** ${evidence}`
        : '';
      return [head, where, ev].filter(Boolean).join('\n');
    })
    .join('\n');
}

/**
 * Summarize the buzz research result into a Markdown list of the top entities.
 * @param {object} result - output of src/research/buzz.js runBuzz()
 * @returns {Promise<string>} markdown (no heading)
 */
export async function summarizeBuzz(result) {
  if (!result?.top?.length) return '';

  const apiKey = process.env.GEMINI_API_KEY;
  const timeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 120000);

  if (!apiKey) {
    console.warn('[summarize] GEMINI_API_KEY not set; using non-AI buzz section.');
    return fallbackBuzzSection(result);
  }

  try {
    const text = await generateWithFallback(buildBuzzPrompt(result), apiKey, timeoutMs);
    console.log('[summarize] buzz: done.');
    return normalizeMarkdownLinks(text || fallbackBuzzSection(result));
  } catch (err) {
    console.error(`[summarize] buzz failed: ${err.message}`);
    return fallbackBuzzSection(result);
  }
}

/**
 * @param {Array<{topic, posts}>} groups
 * @returns {Promise<Array<{topic, section}>>} markdown section per topic
 */
export async function summarizeGroups(groups) {
  const apiKey = process.env.GEMINI_API_KEY;
  const timeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 120000);
  const delayMs = Number(process.env.GEMINI_DELAY_MS || 1500);

  if (!apiKey) {
    console.warn('[summarize] GEMINI_API_KEY not set; using non-AI fallback sections.');
    return groups.map(g => ({ topic: g.topic, section: fallbackSection(g.posts) }));
  }

  const results = [];
  for (const g of groups) {
    try {
      const section = await generateWithFallback(
        buildPrompt(g.topic, g.posts),
        apiKey,
        timeoutMs
      );
      results.push({
        topic: g.topic,
        section: normalizeMarkdownLinks(section || fallbackSection(g.posts))
      });
      console.log(`[summarize] ${g.topic}: done.`);
    } catch (err) {
      console.error(`[summarize] ${g.topic} failed: ${err.message}`);
      results.push({ topic: g.topic, section: fallbackSection(g.posts) });
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}
