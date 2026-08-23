# TypeScript SDK

`@mokronos/wfkit` is the authoring surface: the stable API workflows are written
against. Workflows import only from `@mokronos/wfkit` — never from `effect`
directly — which is what lets the CLI load a stored workflow file with no build
step.

```bash
bun add @mokronos/wfkit
```

```ts
import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const printMessage = defineStep({
  name: "PrintMessage",
  input: t.struct({ message: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(input.message)
  }
})

export const HelloWorkflow = defineWorkflow({
  name: "HelloWorkflow",
  input: t.struct({ message: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    yield* ctx.run(printMessage, { message: input.message.trim() })
  }
})
```

## Entry points

| Import | Contents |
| --- | --- |
| `@mokronos/wfkit` | Everything below: authoring, runtime, client, and test runtime |
| `@mokronos/wfkit/authoring` | Authoring only. Free of runtime imports, so workflow modules can be inspected by non-Bun tooling |
| `@mokronos/wfkit/schemas` | Shared Effect schemas for runs, events, and graphs |
| `@mokronos/wfkit/testing` | `createTestRuntime` and its helpers |

## Schemas: the `t` vocabulary

`t` is a deliberately small, lowercase subset of Effect Schema. It is the whole
type vocabulary a workflow needs, so nothing else has to be imported.

| Member | Effect equivalent |
| --- | --- |
| `t.string`, `t.number`, `t.boolean`, `t.void`, `t.unknown` | `Schema.String`, `Schema.Number`, … |
| `t.date` | A `Date` that encodes to a string, because workflow values cross JSON-backed durable boundaries |
| `t.struct({ … })` | `Schema.Struct` |
| `t.array(schema)` | `Schema.Array` |
| `t.optional(schema)` | `Schema.optional` |
| `t.union([a, b])` | `Schema.Union` |
| `t.literal(value)` | `Schema.Literal` |
| `t.taggedStruct("Tag", { … })` | `Schema.TaggedStruct` — how typed errors are declared |

## defineStep

A step is the unit of durable side effects: retried on thrown errors, its result
persisted so replays never re-execute it.

```ts
const chargeCard = defineStep({
  name: "ChargeCard",
  input: t.struct({ orderId: t.string, amount: t.number }),
  output: t.struct({ paymentId: t.string }),
  errors: PaymentDeclined,
  retry: { attempts: 3, backoff: "none" },
  concurrency: { limit: 5 },
  execute: async (input, step) => {
    if (step.attempt < 2) {
      throw new Error("payment gateway flaked") // transient -> retried
    }
    if (input.amount <= 0) {
      return step.fail({ _tag: "PaymentDeclined", orderId: input.orderId }) // terminal -> never retried
    }
    return { paymentId: `pay_${input.orderId}` }
  },
  // Runs in reverse order if a later part of the workflow fails.
  compensate: async (result) => {
    console.log(`refunding ${result.paymentId}`)
  }
})
```

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | `string` | Durable identity. Combined with an invocation counter into an activity name such as `ChargeCard#1` |
| `input`, `output` | schema | Validated on the way in and out |
| `errors` | schema | Optional. Typed terminal failures, normally a `t.taggedStruct` or a union of them |
| `execute` | `(input, step) => Promise<Output \| TerminalFailure>` | The side effect |
| `compensate` | `(result, input, reason) => unknown` | Optional. Runs in reverse order when the workflow fails after this step succeeded |
| `retry` | `{ attempts: number, backoff: "exponential" \| "none" }` | Applies to thrown errors only |
| `concurrency` | `{ limit: number, key?: (input) => string }` | Caps in-flight executions of this step, optionally per key |

**Thrown vs. returned failures.** A thrown error is transient: the engine
retries it according to `retry`. `step.fail(error)` is terminal: it is never
retried and surfaces as a typed error the workflow can branch on.

The second argument, `step`, carries:

| Member | Meaning |
| --- | --- |
| `step.attempt` | 1-based attempt number |
| `step.executionId` | The run this step belongs to |
| `step.fail(error)` | Build a terminal failure of the declared error type |
| `step.resolveSecret(name, context?)` | Resolve a secret through the runtime's resolver |

## defineWorkflow

```ts
export const OrderWorkflow = defineWorkflow({
  name: "OrderWorkflow",
  input: t.struct({ orderId: t.string, amount: t.number }),
  output: t.struct({ paymentId: t.string }),
  errors: t.union([PaymentDeclined, OrderRejected]),
  run: function* (input, ctx) {
    const payment = yield* ctx.run(chargeCard, input)
    return { paymentId: payment.paymentId }
  }
})
```

The body is a generator that yields orchestration calls. Everything the runtime
must be able to replay goes through `ctx`.

## Orchestration calls

| Call | Meaning |
| --- | --- |
| `ctx.run(step, input)` | Durable step call. The result is persisted; replays skip re-execution |
| `ctx.code(name, { output, run, reason? })` | Plain TypeScript as a first-class, journaled node. `output` is the schema of its return value; `reason` is recorded for human readers |
| `ctx.sleep(duration, name?)` | Durable timer that survives process restarts |
| `ctx.waitForSignal(name, schema, { timeout? })` | Suspend until an external signal arrives |
| `ctx.all([...], { name?, concurrency? })` | Parallel composition, tuple-typed like `Promise.all` |
| `ctx.now()` / `ctx.random()` | Recorded, so replays observe the same values |
| `ctx.fail(error)` | Typed workflow failure. Compensations run in reverse order |
| `ctx.effect(effect)` | Escape hatch for an `Effect` with no requirements |
| `ctx.executionId` | The current run id |

Durations accept the same inputs Effect does — `"2 seconds"`, `"1 hour"`, or a
`Duration`.

### Signals

```ts
const approval = yield* ctx.waitForSignal(
  "managerApproval",
  t.struct({ approved: t.boolean }),
  { timeout: "1 minute" }
)
if (approval.type === "timeout" || !approval.value.approved) {
  return yield* ctx.fail({ _tag: "OrderRejected", reason: "not approved" })
}
```

The outcome is `{ type: "signal", value }` or `{ type: "timeout" }`. While
suspended the process can exit entirely; delivery resumes the run from the
journal, whether it comes from `wf signal`, `client.signal(...)`, or another
process pointed at the same database.

### Code nodes

```ts
const summary = yield* ctx.code("build-review-summary", {
  reason: "Give the human reviewer one stable summary of all results",
  output: t.string,
  run: () => `${created.caseId}: ${customer.name}`
})
```

Return values must be JSON-serializable. Keep `run` free of external side
effects — use `defineStep` for IO, service calls, and anything needing retries
or compensation.

### Determinism

Workflow code re-executes on replay; journaled values do not. Never read the
clock, generate randomness, or perform IO directly in a workflow body — use
`ctx.now()`, `ctx.random()`, and steps. Divergence from the journal raises a
`NonDeterminismError` rather than silently producing a different run.

### Parallel composition

```ts
const [payment, inventory] = yield* ctx.all([
  ctx.run(chargeCard, input),
  ctx.run(reserveInventory, input)
], { name: "reserve-order", concurrency: "unbounded" })
```

The durable engine runs branches concurrently and persists results by activity
name, so completion order does not affect replay. The in-memory runner executes
branches sequentially in array order; it is optimized for tests and graph
tracing.

Each branch should be a single pre-built orchestration call (`ctx.run`,
`ctx.code`, `ctx.sleep`, `ctx.waitForSignal`). Building further `ctx.*` calls
dynamically inside a branch is not replay-safe yet. Inside a durable `ctx.all`,
replay checks use call identity rather than journal position, so divergence
detection inside parallel blocks is coarser than in sequential code.

## Secrets

```ts
import { secret, envSecretResolver } from "@mokronos/wfkit"

const input = { apiKey: secret("stripe-api-key") }
```

`secret(name)` produces a branded reference. Only the reference is persisted;
the runtime's resolver turns it into a value at step execution time.
`envSecretResolver({ mapping?, fallback? })` reads from the environment,
upper-snake-casing the name by default (`stripe-api-key` → `STRIPE_API_KEY`).
Inside a step, `step.resolveSecret(name)` resolves one on demand.

## Embedding the runtime

The CLI is the intended entry point, but the same runtime is available directly:

```ts
import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { OrderWorkflow } from "./order"

const runtime = createWorkflowRuntime({
  backend: "sqlite",
  databasePath: ".wf/quickstart.sqlite"
})
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

try {
  const handle = await client.start(OrderWorkflow, { orderId: "123", amount: 42 })

  const observation = await client.observe(handle.executionId)
  if (observation.type === "signal-suspended") {
    await client.signal(handle.executionId, "managerApproval", { approved: true }, { actor: "manager" })
  }

  console.log("result:", await client.result(handle.executionId))
} finally {
  await client.dispose()
}
```

### createWorkflowRuntime

| Option | Meaning |
| --- | --- |
| `backend` | `"memory"` or `"sqlite"` |
| `databasePath` | Where SQLite state lives |
| `secrets` | A `SecretResolver` for `SecretRef` inputs |
| `timerPollIntervalMs` | How often storage is polled for due timers and undelivered messages. Defaults to 250ms; durable timers can fire up to one interval late |
| `sqliteBusyTimeoutMs` | SQLite busy timeout |

`run(workflow, payload)` is the one-liner alternative for scripts: it builds the
effect and runs it as a main program.

### WorkflowClient

| Method | Meaning |
| --- | --- |
| `start(workflow, payload, opts?)` | Start a run. `opts` carries `idempotencyKey`, `actor`, `artifactId`, `sourceHash` |
| `signal(executionId, name, payload, opts?)` | Deliver a signal. Only accepted once the run is actually waiting for it |
| `observe(executionId, opts?)` | Wait for a terminal result or a signal suspension without exposing polling |
| `result(executionId)` | `{ type: "completed", value }` or `{ type: "failed", error }` |
| `status(executionId)` | Current execution status |
| `execution(executionId)` / `executions()` | Run records |
| `list(workflow, opts?)` | Paged runs for one workflow, filtered by status |
| `history(executionId)` | The durable event history |
| `pendingSignals(executionId)` | What the run is waiting for |
| `cancel(executionId, opts?)` | Cancel, optionally running compensations |
| `dispose()` | Release the database handle |

Because all engine state lives in SQLite, a different process pointed at the
same database can deliver a signal and resume a suspended execution.

## Testing workflows

```ts
import { createTestRuntime } from "@mokronos/wfkit/testing"

const rt = createTestRuntime()
rt.mockStep(chargeCard, async () => ({ paymentId: "pay_test" }))
rt.failStepOnce(reserveInventory)
const compensations = rt.recordCompensations()

const handle = await rt.start(OrderWorkflow, { orderId: "1", amount: 10 })
await rt.sendSignal(handle.executionId, "managerApproval", { approved: true })
await rt.advanceTime("1 hour")

expect(await rt.result(handle.executionId)).toEqual({ type: "completed", value: { paymentId: "pay_test" } })
expect(compensations.calls).toHaveLength(0)
```

| Member | Meaning |
| --- | --- |
| `mockStep(step, impl)` | Replace a step's implementation |
| `failStepOnce(step)` | Make the next attempt throw, to exercise retries |
| `recordCompensations()` | Collect compensation calls as they happen |
| `start(workflow, payload, opts?)` / `replay(executionId, workflow, payload)` | Run, and re-run against the recorded journal |
| `sendSignal`, `advanceTime(duration)` | Drive signals and virtual time (time skipping is on by default) |
| `result`, `status`, `history`, `cancel` | The same observations as the real client |
| `setSecret(name, value)` | Register a secret so `SecretRef` inputs resolve |

`workflow.executeInMemory(payload, options)` runs a workflow with no engine at
all, with hooks to override step execution, sleeps, and signal timeouts. It is
what `wf validate` traces with.
