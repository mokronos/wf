# Plan: resolve the x-engagement FRICTION.md items in the SDK

Source: `examples/x-engagement/FRICTION.md`. Item 4 (signal-resume secret
resolver) is already fixed. This plan resolves items 1–3 with small, additive
SDK changes plus example cleanup. Spec (`docs/spec.md`) gets updated where the
client surface changes.

## 1. Signal discovery → `client.pendingSignals(executionId)`

Problem: external actors must know the exact signal name string and today
discover it by scraping `client.history()` for the last `signal.waiting`.

Solution: add a first-class client method (both memory and durable clients in
`packages/wf/src/sdk/sdk.ts`; share one helper that derives it from history):

```ts
pendingSignals(executionId: string): Promise<ReadonlyArray<PendingSignal>>

interface PendingSignal {
  readonly name: string
  readonly invocation: number
  readonly activityName: string
  readonly timeout?: unknown   // as recorded on the signal.waiting event
}
```

Derivation: a `signal.waiting` history event is pending iff there is no later
`signal.received` or `signal.timeout` event with the same `name` and
`invocation`. Order results by history sequence.

- Export `PendingSignal` type from `wf`.
- Update `examples/x-engagement/review.ts` to use it instead of history
  scraping (both for finding the signal to send and for detecting
  re-suspension after a feedback decision).
- Update `examples/x-engagement/main.ts` to poll `pendingSignals` instead of
  scanning history.
- Document in `docs/spec.md` §4 (Client).
- Tests (extend `packages/wf/test/phase4-client.test.ts` or 4b): pending shows
  the waiting signal; empty after delivery; two sequential waits on the same
  name are disambiguated by `invocation`; timeout-consumed waits are not
  pending.

## 2. Zero-config secrets → `envSecretResolver`

Problem: every app hand-writes a name→env-var resolver; mock mode needs
empty-string fallbacks.

Solution: export a resolver factory from `wf` (new code in `core.ts` or a
small `secrets.ts` module, re-exported from `index.ts`):

```ts
envSecretResolver(options?: {
  mapping?: Record<string, string>  // secret name -> env var name override
  fallback?: string                 // used when the env var is unset
}): SecretResolver
```

- Default env var name: kebab-case secret name → SCREAMING_SNAKE
  (`x-bearer-token` → `X_BEARER_TOKEN`).
- Env var unset: return `fallback` if provided, otherwise throw
  `new Error(\`Secret "<name>" not found: set env var <ENV_VAR>\`)` — a clear,
  actionable error instead of a silent empty string.
- Use it in `examples/x-engagement`: extract the duplicated runtime
  construction from `main.ts`/`review.ts` into a shared
  `examples/x-engagement/runtime.ts` that uses
  `envSecretResolver({ fallback: "" })` (the adapters already treat empty as
  "unconfigured → fixture/local fallback").
- Document in `docs/spec.md` §7 (Bootstrap).
- Tests: default mapping, explicit mapping, fallback, and the throwing case.

## 3. SQLite multi-process contention → busy_timeout + documented ownership

Problem: `main.ts` and `review.ts` as two live SQLite runtimes can hit
`SQLITE_BUSY` / lock errors.

Solution (v1-scoped — do NOT build distributed ownership):

- In `packages/wf/src/runtime.ts` where the sqlite engine layer is built
  (`SqliteClient.layer({ filename })`): WAL is already on by default; add a
  `PRAGMA busy_timeout = 5000;` executed once via the SqlClient when the layer
  initializes, so concurrent writers wait instead of erroring. Expose the
  timeout as an optional `WorkflowRuntimeOptions` field
  (`sqliteBusyTimeoutMs?: number`, default 5000).
- Keep and document the single-live-owner pattern: the example's `main.ts`
  exits after suspension; `review.ts` owns the DB while resuming. State this
  in `examples/x-engagement/README.md` and one line in `docs/spec.md` §7.
- Test: best effort — a test with two concurrently-open sqlite runtimes on the
  same file (starter keeps its runtime alive while the signaler delivers and
  drives to completion). If it cannot be made reliably green, keep the
  sequential regression test as-is and note the limitation in the README
  instead; do NOT ship a flaky test.

## 4. FRICTION.md rewrite

Rewrite `examples/x-engagement/FRICTION.md` as a resolution log: each original
item, one line on the SDK change that resolved it (pendingSignals,
envSecretResolver, busy_timeout + ownership doc, deliverSignal resolver fix).

## Acceptance

- `bun test` and `bun run typecheck` green from repo root (bun at
  `~/.bun/bin/bun` if not on PATH).
- The live flow still works end to end:
  `bun run examples/x-engagement/main.ts` → `review.ts <id> feedback "…"`
  exits cleanly after the re-draft → `review.ts <id> accept` completes.
- No behavior change for existing users beyond the additive API.
