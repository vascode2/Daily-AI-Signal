/**
 * notion.js — Shared Notion REST helpers for the AI-signal digest.
 *
 * Adapted from the sibling digest projects. Uses raw HTTP (no SDK): builds auth
 * headers, converts Markdown → Notion blocks, de-duplicates prior digest pages
 * by title, and creates a new digest page at the top of the parent (newest first).
 */

const NOTION_API = 'https://api.notion.com/v1';
// 2026-03-11 introduced the `position` object (insert at page_start), which we
// use to keep the newest digest on top. Override with NOTION_VERSION.
const NOTION_VERSION = process.env.NOTION_VERSION || '2026-03-11';

export function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** fetch wrapper that retries on 429 / 5xx with backoff, honoring Retry-After. */
async function notionFetch(url, options, { retries = 4, baseDelay = 1000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = parseFloat(res.headers.get('retry-after') || '0');
        const wait = retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** attempt;
        if (attempt < retries) {
          console.log(`   ⏳ Notion ${res.status}; retrying in ${Math.round(wait)}ms`);
          await sleep(wait);
          continue;
        }
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr || new Error('Notion request failed');
}

/** Fetch a page object (used to discover its parent). */
export async function getPage(pageId, token) {
  const res = await notionFetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'GET',
    headers: notionHeaders(token)
  });
  if (!res.ok) throw new Error(`Get page failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Create a plain child page (no digest content) under a parent. Returns page. */
export async function createChildPage(parentPageId, title, token) {
  const res = await notionFetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: { title: { title: [{ text: { content: title } }] } }
    })
  });
  if (!res.ok) throw new Error(`Create page failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function updateParentPageTitle(pageId, targetTitle, token) {
  try {
    const res = await notionFetch(`${NOTION_API}/pages/${pageId}`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({
        properties: { title: { title: [{ text: { content: targetTitle } }] } }
      })
    });
    if (!res.ok) console.log(`   ⚠️  Could not rename parent page title (${res.status})`);
  } catch (err) {
    console.log(`   ⚠️  Could not rename parent page title (${err.message})`);
  }
}

/** Return all direct child blocks of a page/block (paginated). */
export async function listChildBlocks(blockId, token) {
  const out = [];
  let cursor;
  do {
    const url = new URL(`${NOTION_API}/blocks/${blockId}/children`);
    url.searchParams.set('page_size', '100');
    if (cursor) url.searchParams.set('start_cursor', cursor);
    const res = await notionFetch(url.toString(), { method: 'GET', headers: notionHeaders(token) });
    if (!res.ok) throw new Error(`List children failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const json = await res.json();
    out.push(...(json.results || []));
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);
  return out;
}

/** Plain-text title of a child_page block. */
export function childPageTitle(block) {
  if (block?.type !== 'child_page') return null;
  return block.child_page?.title || '';
}

/** Archive (soft-delete) a block by id. */
export async function archiveBlock(blockId, token) {
  const res = await notionFetch(`${NOTION_API}/blocks/${blockId}`, {
    method: 'DELETE',
    headers: notionHeaders(token)
  });
  if (!res.ok) throw new Error(`Archive failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
}

/**
 * Create a digest page under a parent page from already-converted blocks.
 * `position` is an optional Notion position object, e.g. { type: 'page_start' }.
 * Falls back gracefully (no position) if the API rejects the position param.
 */
export async function createDigestPage({ parentPageId, title, blocks, position, token }) {
  const firstBatch = blocks.slice(0, 100);
  const restBatches = [];
  for (let i = 100; i < blocks.length; i += 100) restBatches.push(blocks.slice(i, i + 100));

  const body = {
    parent: { page_id: parentPageId },
    properties: { title: { title: [{ text: { content: title } }] } },
    children: firstBatch
  };
  if (position) body.position = position;

  let res = await notionFetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify(body)
  });

  // If the position parameter is unsupported, retry once without it.
  if (!res.ok && position) {
    const errText = await res.text();
    if (res.status === 400 && /position/i.test(errText)) {
      console.log(`   ⚠️  position param rejected; creating without ordering.`);
      delete body.position;
      res = await notionFetch(`${NOTION_API}/pages`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify(body)
      });
    } else {
      throw new Error(`${res.status}: ${errText}`);
    }
  }
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);

  const page = await res.json();
  for (const batch of restBatches) {
    const r = await notionFetch(`${NOTION_API}/blocks/${page.id}/children`, {
      method: 'PATCH',
      headers: notionHeaders(token),
      body: JSON.stringify({ children: batch })
    });
    if (!r.ok) console.error(`   ⚠️  Append failed: ${r.status}`);
  }
  return page;
}

// ── Markdown → Notion blocks ─────────────────────────────────────

export function markdownToNotionBlocks(md) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    if (trimmed === '---') {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) { blocks.push(headingBlock(1, trimmed.slice(2))); i++; continue; }
    if (trimmed.startsWith('## ')) { blocks.push(headingBlock(2, trimmed.slice(3))); i++; continue; }
    if (trimmed.startsWith('### ')) { blocks.push(headingBlock(3, trimmed.slice(4))); i++; continue; }

    if (trimmed.startsWith('> ')) {
      blocks.push({
        object: 'block',
        type: 'quote',
        quote: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++;
      continue;
    }
    if (trimmed.startsWith('- ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: parseRichText(trimmed.slice(2)) }
      });
      i++;
      continue;
    }

    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: parseRichText(trimmed) }
    });
    i++;
  }
  return blocks;
}

function headingBlock(level, text) {
  const type = `heading_${level}`;
  return { object: 'block', type, [type]: { rich_text: parseRichText(text) } };
}

/**
 * Parse markdown inline syntax into a Notion rich_text array.
 * Handles (in priority order): **[text](url)** bold links, [text](url) links,
 * **bold**, and plain text. A single left-to-right scan avoids the overlap bug
 * where a bold span swallows a link inside it.
 */
export function parseRichText(text) {
  const tokens = [];
  const re =
    /\*\*\[([^\]]+)\]\s*\((https?:\/\/[^)]+)\)\*\*|\[([^\]]+)\]\s*\((https?:\/\/[^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push(plainSegment(text.slice(last, m.index)));
    if (m[1] !== undefined) tokens.push(boldLinkSegment(m[1], m[2]));
    else if (m[3] !== undefined) tokens.push(linkSegment(m[3], m[4]));
    else if (m[5] !== undefined) tokens.push(boldSegment(m[5]));
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(plainSegment(text.slice(last)));
  return tokens.length > 0 ? tokens : [plainSegment(text)];
}

function plainSegment(t) {
  return { type: 'text', text: { content: t.slice(0, 2000) } };
}
function boldSegment(t) {
  return { type: 'text', text: { content: t.slice(0, 2000) }, annotations: { bold: true } };
}
function linkSegment(t, url) {
  return { type: 'text', text: { content: t.slice(0, 2000), link: { url } } };
}
function boldLinkSegment(t, url) {
  return {
    type: 'text',
    text: { content: t.slice(0, 2000), link: { url } },
    annotations: { bold: true }
  };
}

/**
 * Publish a Markdown digest as a child page under the parent, newest on top.
 * De-dupes any existing page with the same title first.
 * @returns {Promise<object|null>} created page (or null if skipped)
 */
export async function publishDigest({ markdown, title, parentPageId, token }) {
  // De-dup existing pages with the same title.
  try {
    const children = await listChildBlocks(parentPageId, token);
    const dupes = children.filter(b => b.type === 'child_page' && childPageTitle(b) === title);
    for (const dup of dupes) {
      await archiveBlock(dup.id, token);
      console.log(`   🗑️  Archived existing page "${title}"`);
    }
  } catch (err) {
    console.log(`   ⚠️  Dedup skipped: ${err.message}`);
  }

  const blocks = markdownToNotionBlocks(markdown);
  const page = await createDigestPage({
    parentPageId,
    title,
    blocks,
    position: { type: 'page_start' },
    token
  });
  return page;
}
