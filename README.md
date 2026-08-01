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
4. **Monitor** — checks [Artificial Analysis](https://artificialanalysis.ai/articles) for
   newly published articles and summarizes what changed.
5. **Render** — assembles a dated Markdown digest, grouped by topic.
6. **Publish** — saves `output/<date>.md` and creates a Notion child page (newest on top).

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
npm start          # full pipeline: collect → summarize → check articles → save → publish
npm run collect    # same, but skip Notion (writes local Markdown only)
npm test           # run the unit + integration tests (node:test, no deps)
npm run e2e:x      # end-to-end smoke test of the X source (fixture → Gemini → Markdown)
```

## 📊 Artificial Analysis monitor

Watches [artificialanalysis.ai/articles](https://artificialanalysis.ai/articles) — an
independent AI benchmarking site — and summarizes anything newly published. The result
is its own section at the top of the daily digest.

```markdown
## 📊 Artificial Analysis — New Articles

> 2 new articles · 2026-07-30 → 2026-07-31

- **[DeepSeek V4 Flash 0731 scores 50 on the Intelligence Index](...)** — 10 points
  above the previous DeepSeek V4 Flash, now matching ...
  - **Why it matters:** open-weights models close the gap on ...
```

When nothing was published the section says so explicitly rather than disappearing, so
a silent section can be told apart from a broken monitor.

**How "new" is decided.** The site has no RSS feed, so the monitor reads the article
index for slugs and each article's OpenGraph tags for title, summary, and
`article:published_time`. Since CI runners keep no state between runs, "new" is a date
window: `lookbackDays: 1` (the default) means *published yesterday or today*, which
reports each article exactly once for a once-a-day schedule. Widen it with
`ARTICLES_LOOKBACK_DAYS` if a scheduled run is ever missed.

Tunables live in `config/articles.json`. Disable with `--skip-articles`,
`DIGEST_SKIP_ARTICLES=true`, or `"enabled": false`.

> Publish dates on the site have day granularity (no clock time), so the window is
> measured in days rather than hours. A failed monitor never breaks the digest — the
> step is wrapped and the rest of the pipeline continues.

> **Reddit credentials are optional.** Without `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`
> the collector uses anonymous RSS, which Reddit throttles to roughly one request per
> 30s per IP. The pipeline handles this by pacing requests and waiting the throttle
> out, so coverage is still complete — it just costs wall time (~5 min for the daily
> collect). With OAuth (free "script" app at
> [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)) the same runs take
> seconds, post scores become available for ranking, and comment sentiment turns on.
> Subreddits that could not be reached are listed in the report.

#### Ranking without scores

Anonymous RSS reports no score or comment count. Those posts are **not** ranked as if
they had zero engagement — that would push every Reddit post below every Hacker News
post before content is considered. Instead they inherit the median engagement of the
posts that do report metrics, so they compete on content signal. See `popularityScore`
in `src/filter.js`.

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

### How to add X cheaply (options people actually use)

If you want X without the full Twitter API price, these are the realistic routes,
roughly cheapest/most-reliable first. All of them plug into the **existing
`playwright` mode** (any command that prints a JSON array of posts to stdout) with
**no code changes** — see the normalized fields in `test/fixtures/x-sample.json`.

- **Third-party scraper APIs (best value)** — services that scrape X and return
  JSON, usually with a small free tier and no Twitter dev account:
  [Apify](https://apify.com) Twitter/X actors, `twitterapi.io`,
  `socialdata.tools`, `scrapecreators.com`, or "Twitter" endpoints on RapidAPI.
  Wrap the call in a tiny script, set `X_PLAYWRIGHT_COMMAND` to run it, and set
  `x.mode = "playwright"`.
- **xAI/Grok `x_search`** — already implemented as `mode: "grok"`; needs credits
  but is the least custom code.
- **`snscrape` (free, flaky)** — the open-source `snscrape` CLI pulls tweets with
  no key. Great for a manual laptop run; unreliable in an automated GitHub Action
  because X rate-limits/blocks CI IPs.
- **RSS bridges (free, unstable)** — RSSHub or a self-hosted Nitter instance can
  expose X accounts as RSS; most public Nitter instances are now dead, so this
  needs self-hosting.

Rule of thumb: for a **reliable daily automated** digest, a paid-but-cheap
scraper API or Grok credits is what holds up; free scrapers are fine for manual
runs but tend to break in CI.

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
- `REDDIT_DELAY_MS` (default: `30000` without OAuth, `600` with)
- `REDDIT_RSS_RETRIES` (default: `3`)
- `REDDIT_RSS_MAX_429_SUBS` (default: `0` = never give up early)
- `X_API_BASE`
- `X_PLAYWRIGHT_COMMAND`
- `X_PLAYWRIGHT_TIMEOUT_MS`
- `XAI_API_BASE`
- `XAI_MODEL`
- `XAI_REQUEST_TIMEOUT_MS`
- `ARTICLES_LOOKBACK_DAYS` (default: `1`)
- `DIGEST_SKIP_ARTICLES` (default: `false`)

If Reddit OAuth secrets are not provided, the workflow still runs — it just paces the
RSS requests, which makes the collect step take a few minutes instead of seconds.

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
- `config/articles.json` — Artificial Analysis monitor: base URL, lookback window, and
  how many article pages to check per run.

All secrets and tunables live in `.env` (see `.env.example`).

## Project structure

```
config/
  sources.json          # source configuration (Reddit today)
  topics.json           # topics + keywords for filtering/grouping
  articles.json         # Artificial Analysis monitor config
src/
  collectors/
    reddit.js           # Reddit collector (implements the collect() contract)
    hackernews.js       # Hacker News collector (official Firebase API)
    x.js                # X.com collector (api | playwright plugin scaffold)
  monitors/
    artificial-analysis.js  # watches artificialanalysis.ai/articles for new posts
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
- [x] Artificial Analysis article monitor
- [ ] LLM-based relevance scoring (replace keyword matching)
- [ ] More monitored publications (blogs, changelogs, release notes)
- [ ] X.com / GitHub trending / RSS / newsletter sources
- [ ] Scheduled daily run (GitHub Actions / cron)
- [ ] Email / webhook / Slack delivery
```

