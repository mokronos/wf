# Workflow SDK — API Specification (v1)

A thin, opinionated SDK over `@effect/workflow`. Goal: hide syntax boilerplate **and** semantic footguns (duplicate step names, retryable-vs-terminal errors, nondeterminism, versioning), while keeping the full engine reachable through an escape hatch.

---

## Design principles

1. **Colocate the authoring model.** A step and its compensation are defined together; the SDK handles call-site attachment under the hood.
2. **Typed, serializable errors everywhere.** Declared errors are terminal business failures (trigger compensation); undeclared thrown errors are transient (retried).
3. **Honest types.** `ctx.run(...)` returns an `Effect` — we alias it as `WorkflowValue<O>` for docs, but we don't pretend it isn't Effect. The escape hatch stays trivial.
4. **No accidental deduplication.** Every `start()` is a fresh execution unless an idempotency key is passed explicitly.
5. **Testing is v1.** A saga you can't test is a saga you don't have.

---

## 1. `defineStep`

```ts
const chargePayment = defineStep({
  name: "chargePayment",

  input:  Schema.Struct({ amount: Schema.Number, customerId: Schema.String }),
  output: Schema.Struct({ transactionId: Schema.String }),

  // Terminal business failures. Serializable, typed, DO NOT retry,
  // and they propagate to the workflow (triggering compensation unwind).
  errors: Schema.Union(
    Schema.TaggedStruct("CardDeclined", { code: Schema.String }),
    Schema.TaggedStruct("CustomerNotFound", {}),
  ),

  execute: async (input, step) => {
    // Plain async function — no Effect knowledge required.
    // - `throw` anything          → transient failure → retried per `retry`
    // - `return step.fail(error)` → typed terminal failure → no retry
    const res = await paymentProvider.charge(input.amount, input.customerId)
    if (res.declined) return step.fail({ _tag: "CardDeclined", code: res.code })
    return { transactionId: res.id }
  },

  // Optional. Receives the successful result, the original input,
  // and the reason the workflow is unwinding.
  compensate: async (result, input, reason) => {
    await paymentProvider.refund(result.transactionId)
  },

  retry: { attempts: 3, backoff: "exponential" },  // applies to transient errors only

  // Optional. Keyed semaphore: at most `limit` concurrent executions of this
  // step per key (step name when `key` is omitted). "10,000 orders arrived,
  // don't call Stripe 10,000 times concurrently" is a day-one requirement.
  // The API shape is the commitment; the v1 implementation is per-node
  // (in-process), not distributed.
  concurrency: { key: (input) => input.customerId, limit: 2 },
})
```

**Step execution context (`step`)** — second argument to `execute`:

```ts
interface StepContext<E> {
  fail(error: E): TerminalFailure<E>   // typed against the step's `errors` schema
  attempt: number                      // current retry attempt (1-based)
  executionId: string
}
```

**What the SDK does invisibly per step:**
- Lifts `execute` into `Effect.tryPromise` with the transient/terminal split mapped onto Effect's error channel.
- Wires `input`/`output`/`errors` schemas into activity persistence.
- Registers `compensate` so `ctx.run` can attach it via `Workflow.withCompensation` at the call site.

---

## 2. `defineWorkflow`

```ts
const OrderWorkflow = defineWorkflow({
  name: "processOrder",

  // REQUIRED. Bump whenever the `run` body changes in a way that alters
  // the sequence/shape of ctx calls. Old executions replay old versions.
  version: 1,

  input:  OrderPayload,
  output: Schema.Struct({ orderId: Schema.String, paymentId: Schema.String }),

  // Workflow-level terminal failures. `ctx.fail` is typed against this union.
  errors: Schema.Union(
    Schema.TaggedStruct("Rejected", { reason: Schema.String }),
    // step `errors` that you let propagate are automatically part of the
    // workflow's failure type — no need to redeclare them here
  ),

  run: function* (payload, ctx) {
    const payment = yield* ctx.run(chargePayment, {
      amount: payload.totalAmount,
      customerId: payload.customerId,
    })

    yield* ctx.run(reserveInventory, { items: payload.items })

    yield* ctx.sleep("1 hour", "coolingOffPeriod")

    const approval = yield* ctx.waitForSignal("managerApproval", ApprovalSchema, {
      timeout: "48 hours",
    })

    // Timeout is a business branch, not an exception:
    if (approval.type === "timeout" || !approval.value.approved) {
      return yield* ctx.fail({ _tag: "Rejected", reason: "no approval" })
      // ↑ triggers the compensation stack: reserveInventory undone (if it
      //   declared a compensate), then chargePayment refunded — LIFO.
    }

    return { orderId: payload.orderId, paymentId: payment.transactionId }
  },
})
```

**Why a generator, stated honestly:** async/await durable execution is possible (Inngest, Restate, Cloudflare Workflows do it via re-execution + memoization + suspension exceptions), but it requires forbidding bare `await` outside `ctx.run` — which is undetectable at compile time — and makes the Effect escape hatch awkward. Generators read the same (`yield*` instead of `await`), stay aligned with the engine's fiber model, and are irrelevant once a no-code UI is generating this code anyway.

---

## 3. `WorkflowContext` (`ctx`)

```ts
interface WorkflowContext<WErrors> {
  /**
   * Run a step. Automatically:
   * - suffixes the underlying activity name with a per-step invocation
   *   counter (`chargePayment#1`, `chargePayment#2`, …) so calling the
   *   same step twice — or in a loop — never replays a stale persisted
   *   result. THIS IS THE MOST IMPORTANT THING THE WRAPPER DOES.
   * - attaches the step's declared `compensate` via Workflow.withCompensation
   * - applies the step's `retry` policy to transient errors only
   */
  run<I, O, E>(step: Step<I, O, E>, input: I): WorkflowValue<O, E>

  /** Run steps concurrently. See "Deferred" — v1 ships sequential only. */
  all<T extends readonly WorkflowValue<any, any>[]>(calls: [...T]): WorkflowValue<ResultsOf<T>>

  /** Durable sleep — survives process restarts. Name required if called
      more than once (same invocation-counter rule as steps). */
  sleep(duration: string, name?: string): WorkflowValue<void>

  /**
   * Wait for an external signal. Timeout is a typed OUTCOME, not a thrown
   * error — timing out on human approval is usually a business branch.
   * Signals delivered BEFORE the workflow reaches the wait point are
   * buffered (FIFO per execution + signal name) and consumed here — an
   * approver clicking while `reserveInventory` is still retrying never
   * loses the approval.
   */
  waitForSignal<T>(
    name: string,
    schema: Schema<T>,
    opts?: { timeout?: string },
  ): WorkflowValue<{ type: "signal"; value: T } | { type: "timeout" }>

  /** Deterministic replacements. Bare Date.now()/Math.random() inside
      `run` silently corrupts replay — these are recorded and replayed. */
  now(): WorkflowValue<Date>
  random(): WorkflowValue<number>

  /** Terminal, typed workflow failure. Unwinds the compensation stack
      (LIFO over every completed step that declared a `compensate`). */
  fail(error: WErrors): WorkflowValue<never>

  /** Escape hatch: raw Effect. Custom services, DurableQueue,
      interruptRetryPolicy, direct WorkflowInstance access — anything the
      wrapper doesn't model. Determinism is YOUR responsibility in here. */
  effect<A, E>(effect: Effect.Effect<A, E>): WorkflowValue<A, E>
}

/** Honest alias — it IS an Effect. Users only ever `yield*` it, but
    power users can `.pipe(...)` without fighting the types. */
type WorkflowValue<A, E = never> = Effect.Effect<A, E, WorkflowScope>
```

---

## 4. Client (outside the workflow)

```ts
const client = createWorkflowClient()  // engine comes from app bootstrap config

// Default: EVERY start is a fresh execution (random execution ID).
const handle = await client.start(OrderWorkflow, payload)

// Deduplication is explicit opt-in, never accidental:
const handle = await client.start(OrderWorkflow, payload, {
  idempotencyKey: payload.orderId,   // same key → same execution, at-most-once
})

handle.executionId  // string
handle.version      // workflow version this execution is pinned to

// start/signal/cancel accept an optional actor, recorded on the
// corresponding history events — audit is core, not an afterthought:
await client.signal(handle.executionId, "managerApproval", { approved: true }, {
  actor: "jane@corp",
})

const result = await client.result(handle.executionId)   // waits for completion
// → { type: "completed", value } | { type: "failed", error } (typed!)

const status = await client.status(handle.executionId)   // non-blocking
// → "running" | "suspended" | "completed" | "failed" | "compensating"

// Cancellation is an engine semantic (it decides whether the compensation
// stack runs), not a platform-layer afterthought:
await client.cancel(handle.executionId, { actor: "ops@corp" })
// compensate: true (default) — wakes the execution at its current suspension
//   point, fails it with a typed Cancelled error, unwinds compensation LIFO,
//   terminal status "failed".
// compensate: false — hard engine interrupt, no unwind (operator kill switch).
await client.cancel(handle.executionId, { compensate: false })
//
// Semantics to know:
// - Every suspension point (sleep, signal wait) races a reserved
//   per-execution cancellation marker, so a suspended execution wakes
//   immediately on cancel.
// - Sleeps under the engine's in-memory threshold (60s) run in-process, so a
//   cancel arriving mid-short-sleep is consumed at the NEXT suspension point
//   — bounded by that threshold. Longer sleeps wake immediately.
// - A cancel racing a simultaneous signal/completion can lose: the workflow
//   completes. Cancellation is best-effort once an execution is past its
//   last suspension point.

// Observability from day one — this is what the eventual no-code UI's
// execution inspector is built on:
const executions = await client.list(OrderWorkflow, {
  status?: Status, limit?: number, cursor?: string,
})

const history = await client.history(handle.executionId)
// → ordered events: step-started / step-completed / step-failed /
//   compensation-run / slept / signal-received / … with payloads

const pending = await client.pendingSignals(handle.executionId)
// → currently open signal waits, ordered by history:
//   { name, invocation, activityName, timeout? }
```

---

## 5. Versioning & replay safety

- `version` on `defineWorkflow` is **required** (no silent default).
- Executions are pinned to the version they started on. Deploying `version: 2` means: new starts run v2, in-flight executions keep replaying v1 — so **old versions must remain registered** until their executions drain (`client.list` tells you when).
- **Replay-divergence detector:** during replay, if the sequence of `ctx` calls (step name + invocation counter + kind) diverges from recorded history, the execution fails loudly with a `NonDeterminismError` naming the divergent step — instead of silently corrupting state.

```ts
registerWorkflows([
  OrderWorkflow,          // version: 2 (current)
  OrderWorkflow_v1,       // kept until drained
])
```

---

## 6. Testing (v1, not deferred)

```ts
const rt = createTestRuntime()   // in-memory engine, no Postgres, no cluster

// Per-step mocking — the saga test you actually want:
rt.mockStep(chargePayment, async (input) => ({ transactionId: "fake-txn" }))
rt.mockStep(reserveInventory, async () => {
  throw new Error("out of stock")   // transient → retried → exhausts → terminal
})

const compensations = rt.recordCompensations()

const exec = await rt.start(OrderWorkflow, testPayload)

// Durable sleeps auto-skip by default; signals are injected programmatically:
await rt.sendSignal(exec.executionId, "managerApproval", { approved: true })

const result = await rt.result(exec.executionId)

expect(result.type).toBe("failed")
expect(compensations.calls).toEqual([
  { step: "chargePayment", result: { transactionId: "fake-txn" } },  // LIFO order
])
```

Runtime knobs: `timeSkipping: true` (default) or `rt.advanceTime("1 hour")` for manual control; `rt.failStepOnce(step)` for retry-path tests.

---

## 7. Bootstrap (app-level, once — not per-workflow)

```ts
// config / composition root — users writing workflows never see this
const engine = createWorkflowRuntime({
  backend: "sqlite",            // or "memory" for local dev
  databasePath: env.WF_DB_PATH,
  secrets: envSecretResolver(),  // secret name -> env var, e.g. stripe-key -> STRIPE_KEY
  sqliteBusyTimeoutMs: 5000,     // default; concurrent SQLite writers wait
})
engine.register([OrderWorkflow, OrderWorkflow_v1, RefundWorkflow])
```

SQLite is intended to have one live workflow owner process per database file in
v1. A second process may open the same file to deliver a signal and resume after
the starter has suspended or exited; `sqliteBusyTimeoutMs` reduces lock races but
does not provide distributed ownership.

**Secret references.** Credentials in step inputs are *references*, never values:

```ts
yield* ctx.run(callStripe, {
  apiKey: secret("stripe-key"),   // serializes as "secret:stripe-key" — only
  amount: payload.totalAmount,    // the reference is ever persisted
})
```

The reference resolves to the real value inside the step's `execute` (via the
bootstrap resolver; `rt.setSecret(name, value)` in the test runtime). The
secret value never appears in persisted payloads, the event store, or
`client.history()` — once a bearer token lands in history it is there forever,
so this is a core serialization rule, not a platform feature.

---

## 8. v1 scope

| In v1 | Deferred |
|---|---|
| `defineStep` (execute + compensate + typed errors + retry) | `ctx.all` fan-out (compensation ordering across branches needs design) |
| `defineWorkflow` + required `version` | Custom backoff beyond `attempts`/`"exponential"` |
| `ctx.run` with invocation counters | Child workflows |
| `ctx.sleep`, `ctx.now`, `ctx.random`, `ctx.fail` | `DurableQueue`, `interruptRetryPolicy` (reachable via `ctx.effect`) |
| `ctx.waitForSignal` + `client.signal` (buffered, typed, timeout-as-value) | Continue-as-new / history truncation |
| `ctx.effect` escape hatch | `patched()`-style intra-version migration |
| Client: `start` / `result` / `status` / `list` / `history` / `cancel` | UI / no-code layer |
| Actor metadata on `start` / `signal` / `cancel` | Task-inbox service (`ctx.humanTask` sugar) |
| `SecretRef` payloads (reference persisted, value resolved in `execute`) | Distributed concurrency limits (v1 is per-node) |
| Per-step `concurrency` keys/limits | Trigger bindings (webhook / cron / polling dispatchers) |
| Test runtime (mocking, time-skip, signal injection, compensation recorder) | |
| Replay-divergence detector | |

---

## Semantics cheat-sheet (what the wrapper guarantees)

- **Duplicate calls are safe.** Same step twice, or in a loop → distinct persisted results via invocation counters.
- **Error taxonomy.** Thrown = transient = retried. `step.fail(...)` / `ctx.fail(...)` = typed terminal = compensation unwind, no retry.
- **Compensation.** Declared once on the step, attached automatically at every `ctx.run` call site, unwound LIFO over completed steps on terminal failure.
- **Determinism.** `ctx.now`/`ctx.random` are recorded; divergence between code and history fails loudly, never silently.
- **Identity.** Fresh execution per `start()` by default; dedup only via explicit `idempotencyKey`.
- **Signals.** Typed payloads, validated at delivery; early deliveries buffered per execution+name; timeout is a value, not an exception.
- **Cancellation.** `compensate: true` wakes the execution and unwinds LIFO; `false` is a hard kill. Mid-short-sleep cancels land at the next suspension point.
- **Secrets.** `secret("name")` persists as a reference; the value exists only inside `execute`.
- **Audit.** `start`/`signal`/`cancel` record their `actor` in history.
- **Power.** Anything not modeled is one `ctx.effect(...)` away.
