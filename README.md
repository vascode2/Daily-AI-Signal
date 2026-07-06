# 🤖 Daily AI Signal

A daily AI-signal digest. It collects high-signal AI posts from Reddit, filters
out noise, ranks by practical usefulness, summarizes the best ones with the
Gemini API, and publishes a clean Markdown digest to a local `output/` folder
and to a **Daily AI Signal** page in Notion.

Built as a sibling to `Daily-Youtube-Digest` and `Daily-News-Digest`, reusing the
same Gemini + Notion conventions.

## What it does

1. **Collect** — pulls top posts from configured subreddits (Reddit public JSON API, no auth).
2. **Filter & rank** — matches posts to your AI topics, drops noise, scores usefulness.
3. **Summarize** — Gemini writes a concise, per-topic Markdown section.
4. **Render** — assembles a dated Markdown digest, grouped by topic.
5. **Publish** — saves `output/<date>.md` and creates a Notion child page (newest on top).

## Topics tracked

Local LLMs · Open-source models · AI coding tools · AI agents · AI automation ·
AI app development · AI productivity & business · AI hardware & edge · Practical AI tools

## Quick start

```bash
npm install
cp .env.example .env
# Fill in GEMINI_API_KEY and NOTION_TOKEN (reuse from your other digest projects).
```

### Create the Notion page (one time)

Point the setup script at an existing digest page (e.g. your YouTube Digest page).
It creates a **Daily AI Signal** page as a sibling and prints the new page id:

```bash
SIBLING_PAGE_ID=<your-existing-page-id> npm run setup:notion
# Copy the printed id into .env as NOTION_PAGE_ID
```

If your existing page is at the workspace root, just create a page named
**Daily AI Signal** in Notion, share it with your integration, and paste its id
into `NOTION_PAGE_ID`.

### Run

```bash
npm start          # full pipeline: collect → summarize → save → publish to Notion
npm run collect    # same, but skip Notion (writes local Markdown only)
```

## GitHub Actions (Daily Automation)

This repo includes a scheduled workflow at
`.github/workflows/daily-ai-signal.yml`.

- Schedule: daily at `10:30 UTC` (about `06:30 America/New_York`)
- Also supports manual run via **Actions → Daily AI Signal → Run workflow**

### Required GitHub repository secrets

- `GEMINI_API_KEY`
- `NOTION_TOKEN`
- `NOTION_PAGE_ID`

### Optional GitHub repository secrets

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`

### Optional GitHub repository variables

- `DIGEST_TIMEZONE` (default: `America/New_York`)
- `DIGEST_SKIP_NOTION` (default: `false`)
- `GEMINI_MODEL`
- `GEMINI_MODEL_FALLBACKS`
- `GEMINI_REQUEST_TIMEOUT_MS`
- `GEMINI_DELAY_MS`
- `NOTION_ROOT_TITLE`
- `NOTION_VERSION`
- `REDDIT_USER_AGENT`
- `REDDIT_DELAY_MS`
- `REDDIT_RSS_RETRIES`
- `REDDIT_RSS_MAX_429_SUBS`

If Reddit OAuth secrets are not provided, the workflow still runs with Reddit RSS
best-effort collection plus Hacker News.

## Configuration

- `config/sources.json` — subreddits, sort (`top`/`hot`/`new`), time window, per-sub limit, min score.
- `config/topics.json` — topics, their matching keywords, and max posts per topic.

All secrets and tunables live in `.env` (see `.env.example`).

## Project structure

```
config/
  sources.json          # source configuration (Reddit today)
  topics.json           # topics + keywords for filtering/grouping
src/
  collectors/
    reddit.js           # Reddit collector (implements the collect() contract)
  filter.js             # relevance filter, ranking, topic grouping
  summarize.js          # Gemini summarization (raw HTTP + model fallback)
  render-markdown.js    # builds and saves the Markdown digest
  notion.js             # Notion REST helpers (markdown → blocks, publish)
  index.js              # pipeline orchestrator
scripts/
  setup-notion.js       # one-time: create the Daily AI Signal parent page
output/                 # generated digests: <date>.md
```

## Adding a new source (X, GitHub, RSS, ...)

1. Create `src/collectors/<name>.js` that exports `async collect(config)` returning
   the normalized post shape documented in `reddit.js`.
2. Add a `<name>` section to `config/sources.json`.
3. Register it in the `COLLECTORS` map in `src/index.js`.

No other code needs to change — filtering, summarizing, rendering, and publishing
all operate on the normalized post shape.

## Roadmap

- [x] Reddit collection (MVP)
- [x] Gemini summarization + Notion publishing
- [ ] LLM-based relevance scoring (replace keyword matching)
- [ ] X.com / GitHub trending / RSS / newsletter sources
- [ ] Scheduled daily run (GitHub Actions / cron)
- [ ] Email / webhook / Slack delivery
```

