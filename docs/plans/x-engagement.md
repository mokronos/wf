# Plan: X.com Engagement Assistant (example workflow)

An example workflow that sweeps the user's X.com home timeline, drafts a
question/comment per interesting post via an LLM, runs a human-in-the-loop
review (accept / edit / feedback / decline), and posts the approved reply.

This doubles as a dogfooding test: it should be implementable against the
current `wf` SDK surface (see `docs/spec.md`, `examples/quickstart/`) without
touching the SDK itself. If something in the SDK blocks a natural
implementation, record it in `examples/x-engagement/FRICTION.md` instead of
working around it silently.

## External API constraints (researched 2026-07-04)

- **X API**: no free tier exists anymore (removed for new developers Feb 2026).
  Pay-per-use: ~$0.001 per "owned read" (reverse-chronological home timeline is
  in that class), ~$0.015 per post created. Endpoints:
  `GET /2/users/:id/timelines/reverse_chronological` (home timeline),
  `POST /2/tweets` with `reply.in_reply_to_tweet_id` (reply). OAuth user
  context required for both.
  → The example must run fully **without X credentials by default**, using a
  bundled fixture timeline. The real client is implemented but only activated
  when credentials are configured, and posting additionally requires opting
  out of dry-run.
- **opencode zen**: OpenAI-compatible endpoint
  `https://opencode.ai/zen/v1/chat/completions` (models list at `/v1/models`).
  Free models available (e.g. `minimax-m2.5-free`, `big-pickle`,
  `nemotron-3-super-free`). Requires an API key from opencode zen. Model id
  goes in the request body as usual for OpenAI-compatible APIs.
  → Default model: a free one, configurable via env `ZEN_MODEL`.

## Location & shape

- `examples/x-engagement/` with:
  - `workflow.ts` — steps + `XEngagementWorkflow` (the core deliverable)
  - `adapters.ts` (or similar) — `TimelineSource` / `ReplyPoster` (mock + real X impl),
    zen chat-completion helper (`baseUrl` injectable for tests)
  - `fixtures/timeline.json` — ~8 realistic timeline posts (mix of engageable
    posts, retweets, replies, ads-ish noise)
  - `main.ts` — runs it end-to-end like `examples/quickstart/main.ts`
    (sqlite runtime at `.wf/x-engagement.sqlite`)
  - `review.ts` — tiny shell HITL helper:
    `bun run examples/x-engagement/review.ts <executionId> accept|decline|edit "text"|feedback "note"`
    → sends the `reviewDecision` signal via `client.signal(...)` with
    `{ actor: "shell-reviewer" }`
  - `README.md` — how to run (mock mode zero-config), which env vars/secrets
    enable real mode, cost warning for X API
  - `FRICTION.md` — anything about the SDK that was awkward/blocking (honest;
    empty file if truly nothing)
- Test: `packages/wf/test/` is for SDK phases — put the example's test at
  `examples/x-engagement/workflow.test.ts` using `createTestRuntime` from `wf`.

## Workflow design

`XEngagementWorkflow` (version 1):

- **input**: `{ maxCandidates?: number (default 2), maxRevisions?: number (default 3), dryRun?: boolean (default true) }`
- **output**: summary `{ considered: number, posted: Array<{ postId, replyText }>, skipped: Array<{ postId, reason }> }`

Steps:

1. **fetchTimeline** — returns recent home-timeline posts
   `{ id, author, text, createdAt }[]`. Mock mode reads the fixture; real mode
   calls the X API with `secret("x-bearer-token")` in its input (SecretRef —
   the token must never appear in history/SQLite; the phase 7 tests show the
   pattern). Retry: `{ attempts: 3, backoff: "exponential" }`.
2. **selectCandidates** — deterministic pre-filter (drop retweets/replies),
   then one zen call ranking the remainder for "worth engaging with", return
   top `maxCandidates` with a one-line reason each. Zen API key as
   `secret("opencode-zen-api-key")`.
3. Per candidate (plain loop in the workflow body — no `ctx.all` in v1;
   per-step invocation counters make loops replay-safe):
   a. **draftReply** — zen call: given the post (+ accumulated reviewer
      feedback, if any revision round), draft a short, genuine
      question/comment. No hashtags, no sycophancy — style guidance in the
      prompt.
   b. **notifyReviewer** — prints the post, the draft, and the exact
      `review.ts` commands to respond. (A `DiscordNotifier` variant may be
      stubbed with a clearly marked placeholder — webhook URL as a SecretRef —
      but console is the working default.)
   c. `ctx.waitForSignal("reviewDecision", Decision, { timeout: "24 hours" })`
      where `Decision` is a tagged union:
      - `accept` → post as drafted
      - `edit { text }` → post the edited text verbatim
      - `feedback { note }` → loop back to (a) with the note appended;
        bounded by `maxRevisions`, then treated as decline
      - `decline` → skip post
      Timeout is a **value branch** (skip with reason "review-timeout"), not
      an error.
      Note: signal names in a loop need disambiguation — check how the SDK
      scopes signal waits per invocation; if a per-iteration name like
      `reviewDecision` with the SDK's invocation counter doesn't disambiguate
      from the *outside* (the reviewer signals by name), include the post id
      in the signal name (e.g. `reviewDecision:<postId>`) and have
      `notifyReviewer` print the exact name. Record whichever way it lands in
      FRICTION.md.
   d. **postReply** — `dryRun: true` (default) logs what would be posted;
      real mode `POST /2/tweets`. `concurrency: { limit: 1 }`,
      retry `{ attempts: 3, backoff: "exponential" }`. A duplicate-reply
      rejection from X is a **typed terminal error** (`step.fail`), not a
      retry.

## Testing (must pass without network access)

Use `createTestRuntime`:

- `rt.setSecret(...)` for both secrets.
- Zen calls hit a local stub (inject `baseUrl` pointing at a `Bun.serve`
  stub, or an injectable fetch) — never the real endpoint in tests.
- Scenarios: accept path posts; edit path posts edited text; feedback loops
  then accepts (assert the revision prompt contained the feedback); decline
  and timeout skip; secret values absent from serialized history.

## Acceptance

- `bun test` and `bun run typecheck` green from repo root (bun may be at
  `~/.bun/bin/bun`).
- `bun run examples/x-engagement/main.ts` works zero-config in mock+dryRun
  mode: starts, prints a draft, suspends; `review.ts <id> accept` completes it.
- No secret value ever appears in `client.history()` output or the SQLite file.
- Style matches `examples/quickstart/` (comment density, `t` schemas, tagged
  errors).
