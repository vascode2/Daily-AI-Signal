# daily-ai-signal

This project creates a daily AI signal digest from online sources.

## Purpose

Collect useful AI-related discussions from Reddit first, then later expand to X.com/Twitter, YouTube, GitHub, RSS, newsletters, or other sources.

The goal is not to collect everything. The goal is to find practical, high-signal AI information worth reading.

## Main topics

* Local LLMs
* Open-source AI models
* AI coding tools
* AI agents
* AI automation
* AI productivity
* AI app development
* Edge AI and on-device inference
* AI business or side-project ideas

## Initial source

Start with Reddit.

Example subreddits:

* r/LocalLLaMA
* r/MachineLearning
* r/artificial
* r/singularity
* r/OpenAI
* r/ClaudeAI
* r/cursor
* r/selfhosted
* r/SideProject
* r/ChatGPTCoding

## Output

Generate a daily Markdown digest under `output/`.

Later outputs may include:

* Notion
* Email
* Webhook
* Slack
* GitHub Pages

## Design principles

* Keep it simple.
* Build Reddit MVP first.
* Make source collectors modular.
* Use Gemini API for summarization.
* Prefer practical summaries over academic summaries.
* Highlight tools, workflows, project ideas, technical insights, and trends.

## Architecture (for AI assistants)

Node.js, ES modules (`"type": "module"`), no build step. Raw HTTP `fetch()` for
both Gemini and Notion (no SDKs), matching the sibling projects
`Daily-Youtube-Digest` and `Daily-News-Digest`.

Pipeline (`src/index.js`): collect → filter/rank/group → summarize → monitor articles →
render → publish.

```
config/sources.json   # source config (subreddits, sort, limits, minScore)
config/topics.json    # topics + keywords + maxPostsPerTopic
config/articles.json  # Artificial Analysis monitor: base URL, lookback, fetch caps
src/collectors/reddit.js  # exports async collect(config) -> normalized posts
src/monitors/artificial-analysis.js
                      # findNewArticles(config) -> articles published in the window
src/filter.js         # filterAndGroup(posts, topicsConfig) -> [{topic, posts}]
src/summarize.js      # summarizeGroups(groups), summarizeArticles(articles) via Gemini
src/render-markdown.js# buildDigest(), buildArticlesSection(), saveDigest()
src/notion.js         # markdown → blocks, publishDigest() (child page, newest on top)
src/index.js          # orchestrator
scripts/setup-notion.js   # one-time: create the "Daily AI Signal" parent page
```

### Artificial Analysis monitor

Watches https://artificialanalysis.ai/articles and reports newly published pieces as
their own section at the top of the digest.

* The site has **no RSS feed**. Slugs come from the article index; per-article
  metadata comes from **OpenGraph meta tags** (`og:title`, `og:description`,
  `article:published_time`). Prefer meta tags — they are a stable public contract,
  unlike the Next.js RSC payload.
* `parseBody()` scrapes article prose out of the RSC payload for a richer Gemini
  prompt. That format is an internal detail, so the function must never throw and
  the pipeline must stay correct when it returns `''` (`og:description` is the
  guaranteed fallback).
* **"New" is a date window, not stored state**, because CI runners persist nothing.
  `lookbackDays: 1` means "published yesterday or today", which reports each article
  exactly once on a daily schedule. Publish dates have day granularity (no clock
  time), so never express this window in hours.
* The index is newest-first and the scan relies on it: the walk stops at the first
  article older than the cutoff instead of fetching every page.
* An empty result still renders a "no new articles" line — a silent section would be
  indistinguishable from a broken monitor.

### Normalized post shape (the source contract)

Every collector's `collect(config)` returns objects of this shape:
`{ source, id, title, url, permalink, score, numComments, subreddit, author, selftext, created }`.
Optional: `metricsKnown` (boolean) — set to `false` when the source cannot report
engagement (Reddit RSS). Ranking substitutes the median engagement of scored posts
rather than treating the zeros as real, so unscored posts are not buried. When the
field is absent it is inferred from `score`/`numComments`.
Adding a new source = new file in `src/collectors/`, a section in
`config/sources.json`, and one line in the `COLLECTORS` map in `src/index.js`.

### Conventions

* Gemini: `GEMINI_MODEL` + `GEMINI_MODEL_FALLBACKS` chain; retry-next on 404/429.
* Notion: `NOTION_TOKEN` + `NOTION_PAGE_ID` (parent page); each day is a child page
  titled `🤖 Daily AI Signal — <date>`, inserted at `page_start`, de-duped by title.
* Secrets/tunables in `.env` (see `.env.example`). Never commit `.env`.
* Graceful degradation: missing `GEMINI_API_KEY` → non-AI fallback sections;
  missing Notion vars or `--skip-notion` → local Markdown only; article-monitor
  failures never break the digest (`--skip-articles` / `DIGEST_SKIP_ARTICLES`).

### Run

* `npm start` — full pipeline (includes Notion).
* `npm run collect` — pipeline without Notion (local Markdown only).
* `npm run setup:notion` — create the Notion parent page once.
* `npm test` — node:test suite (offline; no network, no Gemini).
