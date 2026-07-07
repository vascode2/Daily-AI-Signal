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
npm test           # run the unit + integration tests (node:test, no deps)
npm run e2e:x      # end-to-end smoke test of the X source (fixture → Gemini → Markdown)
```

### X.com source

**X is disabled by default to keep the pipeline free.** Reddit + Hacker News +
the Gemini free API tier cost nothing to run. X requires a paid data source (see
Cost & budget below), so enable it only when you're ready.

X is a plugin-style collector. Enable it in `config/sources.json`
(`x.enabled = true`) and choose a `mode`:

- `mode: "grok"` — **use your Grok/xAI API key** (`XAI_API_KEY`) with the
  built-in `x_search` tool. This is the easiest way to collect X posts and does
  **not** require a Twitter developer account. Note: a Grok key is NOT a
  Twitter/X bearer token, and the xAI API is **paid** (needs credits).
- `mode: "api"` — official X recent-search API. Needs a Twitter developer
  `X_BEARER_TOKEN` (the free Twitter tier has no search).
- `mode: "playwright"` — an external scraper command (`X_PLAYWRIGHT_COMMAND`)
  that prints a JSON array of posts to stdout.
- `mode: "fixture"` — load posts from a local JSON file
  (`X_FIXTURE_PATH`, default `test/fixtures/x-sample.json`). No credentials
  needed — ideal for offline testing, CI, and demos.

The `hoursBack`, `minScore`, and `lang` settings in the `x` config are applied
uniformly across all modes.

## Cost & budget

This project is designed to run **for free**:

- **Reddit** — free (public RSS, or free OAuth app credentials).
- **Hacker News** — free (public Firebase API).
- **Gemini summarization** — free API tier from Google AI Studio
  (`GEMINI_API_KEY`). Note: a Gemini **Advanced** consumer subscription is not
  the same thing — you need an API key, which has its own free tier.
- **Notion publishing** — free.

**X is the only paid source.** There is no usable free tier for X search:
xAI's `x_search` (grok mode) needs account credits, and Twitter's free API has
no search. Consumer chat subscriptions (ChatGPT Plus, Claude Pro, Gemini
Advanced) do **not** provide API access, so they can't be used here. If you want
X, the cheapest path is funding a small amount of xAI credits (check the
data-sharing free-credits program at <https://console.x.ai> → Billing), then set
`x.enabled = true`.

## GitHub Actions (Daily Automation)

This repo includes a scheduled workflow at
`.github/workflows/daily-ai-signal.yml`.

- Schedule: daily at `03:30 America/New_York` (DST-safe via `07:30` + `08:30` UTC triggers)
- Also supports manual run via **Actions → Daily AI Signal → Run workflow**

### Required GitHub repository secrets

- `GEMINI_API_KEY`
- `NOTION_TOKEN`
- `NOTION_PAGE_ID`

### Optional GitHub repository secrets

- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `X_BEARER_TOKEN` (only for X `api` mode)
- `XAI_API_KEY` (only for X `grok` mode — your Grok/xAI key)

### Optional GitHub repository variables

- `DIGEST_TIMEZONE` (default: `America/New_York`)
- `DIGEST_LANGUAGE` (default: `en`)
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
- `X_API_BASE`
- `X_PLAYWRIGHT_COMMAND`
- `X_PLAYWRIGHT_TIMEOUT_MS`
- `XAI_API_BASE`
- `XAI_MODEL`
- `XAI_REQUEST_TIMEOUT_MS`

If Reddit OAuth secrets are not provided, the workflow still runs with Reddit RSS
best-effort collection plus Hacker News.

X is scaffolded in plugin form. To collect X posts, set
`config/sources.json -> x.enabled = true`, then choose a mode:

- `mode: "grok"` + `XAI_API_KEY` (Grok/xAI key — recommended, no Twitter account)
- `mode: "api"` + `X_BEARER_TOKEN` (Twitter developer bearer token)
- `mode: "playwright"` + `X_PLAYWRIGHT_COMMAND`
- `mode: "fixture"` + `X_FIXTURE_PATH` (offline/CI, no credentials)

## Configuration

- `config/sources.json` — subreddits, sort (`top`/`hot`/`new`), time window, per-sub limit, min score.
- `config/sources.json` — source settings for Reddit, Hacker News, and future X collection.
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
    hackernews.js       # Hacker News collector (official Firebase API)
    x.js                # X.com collector (api | playwright plugin scaffold)
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

