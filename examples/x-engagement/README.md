# X.com Engagement Assistant

Example workflow that reads an X home timeline, ranks posts worth replying to, drafts a short reply, waits for a human decision, and posts the approved reply.

Run zero-config mock mode:

```bash
bun run examples/x-engagement/main.ts
```

The default uses `fixtures/timeline.json`, local deterministic ranking/drafting when no Zen key is configured, and `dryRun: true`. `main.ts` exits after the workflow is durably suspended for review. Respond with:

```bash
bun run examples/x-engagement/review.ts <executionId> accept
bun run examples/x-engagement/review.ts <executionId> decline
bun run examples/x-engagement/review.ts <executionId> edit "replacement text"
bun run examples/x-engagement/review.ts <executionId> feedback "make it more specific"
```

SQLite ownership is intentionally simple in this demo: `main.ts` starts the run
and exits once it is suspended, then `review.ts` owns the same database while it
delivers the signal and drives the resumed workflow.

Real X mode is opt-in:

```bash
export X_ENGAGEMENT_REAL_X=1
export X_USER_ID=<your-user-id>
export X_BEARER_TOKEN=<oauth-user-context-token>
export OPENCODE_ZEN_API_KEY=<zen-api-key>
export X_ENGAGEMENT_DRY_RUN=0
bun run examples/x-engagement/main.ts
```

Cost warning: X API access is not free for new developers as of 2026-07-04. Home timeline reads and created posts may incur pay-per-use charges. Keep `X_ENGAGEMENT_DRY_RUN` enabled until you are ready to post.

Optional Zen settings:

- `OPENCODE_ZEN_API_KEY`: enables OpenAI-compatible Zen chat completions.
- `ZEN_MODEL`: intended model override; the workflow currently passes the free default model from the plan.

Secrets are passed to steps as `secret(...)` references. The shared runtime uses
`envSecretResolver({ fallback: "" })`, so unset env vars fall back to mock/local
adapters while history and SQLite store only the reference names, not credential
values.

The workflow input defaults to `maxCandidates: 2`; the CLI demo starts one candidate by default so a single review command completes the smoke flow. Set `X_ENGAGEMENT_MAX_CANDIDATES` to process more.
