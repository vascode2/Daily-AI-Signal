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

Pipeline (`src/index.js`): collect → filter/rank/group → summarize → buzz research →
render → publish.

```
config/sources.json   # source config (subreddits, sort, limits, minScore)
config/topics.json    # topics + keywords + maxPostsPerTopic
config/buzz.json      # buzz research: subreddits, window, weights, entity registry
src/collectors/reddit.js  # exports async collect(config) -> normalized posts
                          # also fetchComments(permalink, limit) and hasOAuth()
src/research/buzz.js  # runBuzz(config) -> ranked AI entities + evidence (4h window)
src/research/sentiment.js # deterministic AI-slang sentiment lexicon
src/filter.js         # filterAndGroup(posts, topicsConfig) -> [{topic, posts}]
src/summarize.js      # summarizeGroups(groups), summarizeBuzz(result) via Gemini
src/render-markdown.js# buildDigest(), buildBuzzSection(), saveDigest(), saveResearch()
src/notion.js         # markdown → blocks, publishDigest() (child page, newest on top)
src/index.js          # orchestrator
scripts/setup-notion.js   # one-time: create the "Daily AI Signal" parent page
scripts/buzz.js       # standalone buzz research run (npm run buzz)
```

### AI Buzz research (sentiment)

Answers "which AI is being talked about right now, and why?" over a short window
(default 4h) across r/codex, r/OpenAI, r/ChatGPT, r/ClaudeAI, r/ClaudeCode,
r/vibecoding, r/singularity.

* All ranking/sentiment math is **deterministic and offline-testable**; Gemini only
  writes the human explanation for the top N. Keep it that way — it makes
  `test/buzz.test.js` reliable and the numbers reproducible.
* Entity matching uses one longest-alias-first regex across the whole registry, with
  `(?<![a-z0-9])`/`(?![a-z0-9])` guards (not `\b`), so "claude code" doesn't
  double-count as "claude" and "grokking" doesn't match "Grok". New models go in
  `config/buzz.json -> entities`.
* Per-post mention caps (title 2 / body 3 / comments 8) stop one repetitive post from
  dominating the ranking.
* Reddit access reality: anonymous RSS allows ~1 request per ~30s per IP, so the buzz
  collector passes patient pacing overrides (`delayMs`, `rssRetries`, `rssBackoffMs`,
  `max429Failures: 0`) into `reddit.collect()`, and skips comment analysis entirely
  without OAuth. With `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` the run is fast and
  includes comment sentiment. Unreachable subreddits are reported in the output.

### Normalized post shape (the source contract)

Every collector's `collect(config)` returns objects of this shape:
`{ source, id, title, url, permalink, score, numComments, subreddit, author, selftext, created }`.
Adding a new source = new file in `src/collectors/`, a section in
`config/sources.json`, and one line in the `COLLECTORS` map in `src/index.js`.

### Conventions

* Gemini: `GEMINI_MODEL` + `GEMINI_MODEL_FALLBACKS` chain; retry-next on 404/429.
* Notion: `NOTION_TOKEN` + `NOTION_PAGE_ID` (parent page); each day is a child page
  titled `🤖 Daily AI Signal — <date>`, inserted at `page_start`, de-duped by title.
* Secrets/tunables in `.env` (see `.env.example`). Never commit `.env`.
* Graceful degradation: missing `GEMINI_API_KEY` → non-AI fallback sections;
  missing Notion vars or `--skip-notion` → local Markdown only; buzz research
  failures never break the digest (`--skip-buzz` / `DIGEST_SKIP_BUZZ` to disable).

### Run

* `npm start` — full pipeline (includes Notion).
* `npm run collect` — pipeline without Notion (local Markdown only).
* `npm run buzz` — standalone AI Buzz research (`--hours=N`, `--top=N`, `--json`, `--notion`).
* `npm run setup:notion` — create the Notion parent page once.
* `npm test` — node:test suite (offline; no network, no Gemini).
