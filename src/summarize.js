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
  const primary = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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

Below are posts already filtered to this topic, from Reddit and Hacker News. Write a concise, high-signal Markdown section.

Rules:
- Start with ONE short sentence (plain text, no heading) summarizing the theme of this topic today.
- Then a Markdown bullet list, one bullet per post, in this exact format:
  - **[<short punchy title>](<link>)** — 1-2 sentences on the key insight and why it is practically useful. (<source>)
- The <source> tag MUST be included at the end of each bullet, exactly as provided (e.g. "r/LocalLLaMA", "Hacker News").
- Keep it factual and specific. No hype, no filler, no emojis.
- Do NOT add a topic heading (it is added by the renderer).
- Skip low-value posts instead of padding.

Posts:
${list}`;
}

function fallbackSection(posts) {
  const intro = 'AI summary unavailable — showing top posts for this topic.';
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
      results.push({ topic: g.topic, section: section || fallbackSection(g.posts) });
      console.log(`[summarize] ${g.topic}: done.`);
    } catch (err) {
      console.error(`[summarize] ${g.topic} failed: ${err.message}`);
      results.push({ topic: g.topic, section: fallbackSection(g.posts) });
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}
