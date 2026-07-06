/**
 * setup-notion.js — one-time helper to create the "Daily AI Signal" parent page.
 *
 * It looks at an existing digest page (SIBLING_PAGE_ID, e.g. your YouTube Digest
 * page) to find its parent, then creates a new "Daily AI Signal" page as a
 * sibling under that same parent. Finally it prints the new page id so you can
 * paste it into .env as NOTION_PAGE_ID.
 *
 * Usage:
 *   NOTION_TOKEN=... SIBLING_PAGE_ID=<existing-page-id> node scripts/setup-notion.js
 * or set them in .env and run `npm run setup:notion`.
 */

import 'dotenv/config';
import { getPage, createChildPage } from '../src/notion.js';

async function main() {
  const token = process.env.NOTION_TOKEN;
  const siblingId = process.env.SIBLING_PAGE_ID;
  const title = process.env.NOTION_ROOT_TITLE || 'Daily AI Signal';

  if (!token) throw new Error('NOTION_TOKEN is required.');
  if (!siblingId) {
    throw new Error(
      'SIBLING_PAGE_ID is required (an existing page whose parent will hold the new page).'
    );
  }

  console.log(`Looking up parent of ${siblingId}...`);
  const sibling = await getPage(siblingId, token);
  const parent = sibling.parent || {};

  let parentPageId = null;
  if (parent.type === 'page_id') parentPageId = parent.page_id;

  // Preferred: create as a sibling under the shared parent. If the integration
  // can't see the parent (common), fall back to nesting under the sibling page
  // itself, which the integration provably can access.
  let page;
  if (parentPageId) {
    try {
      console.log(`Creating "${title}" as a sibling under parent ${parentPageId}...`);
      page = await createChildPage(parentPageId, title, token);
    } catch (err) {
      console.log(`   ⚠️  Parent not accessible (${err.message.slice(0, 80)}).`);
      console.log(`   ↪ Falling back to nesting "${title}" under ${siblingId}.`);
      page = await createChildPage(siblingId, title, token);
    }
  } else {
    console.log(`Creating "${title}" nested under ${siblingId}...`);
    page = await createChildPage(siblingId, title, token);
  }

  console.log('\n✅ Created page.');
  console.log(`   id:  ${page.id}`);
  console.log(`   url: ${page.url}`);
  console.log(`\nAdd this to your .env:\n   NOTION_PAGE_ID=${page.id.replace(/-/g, '')}`);
}

main().catch(err => {
  console.error('setup-notion failed:', err.message);
  process.exit(1);
});
