# wf

Durable workflows in plain TypeScript. You author workflows with typed inputs,
outputs, and errors; the engine (built on `@effect/workflow`) persists every
step result, timer, and signal wait in SQLite, so executions replay
deterministically and survive process restarts. Authored workflows import only
from `@mokronos/wfkit` — never from `effect` directly.

## Install

```bash
bun add @mokronos/wfkit
bun add -g @mokronos/wfkit
```

## Quickstart

A tiny workflow is just a typed step plus a typed workflow that calls it:

```ts
import { defineStep, defineWorkflow, run, t } from "@mokronos/wfkit"

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
  version: 1,
  input: t.struct({ message: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    yield* ctx.run(printMessage, {
      message: input.message.trim()
    })
  }
})

run(HelloWorkflow, { message: "hello from wf" })
```

For a runnable version of the same standalone style, see
[examples/email](examples/email):

```bash
bun run example:email
```

## CLI

Install `@mokronos/wfkit` globally, then run CLI commands with the `wf` binary:

```bash
wf <command>
```

### `create`

Create or import a workflow into the local SQLite catalog:

```bash
wf create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]
```

Examples:

```bash
wf create welcome-email
wf create email --file examples/email/email.ts
wf create invoice-sync --file workflows/invoice-sync.ts --version v1
```

With no `--source` or `--file`, the CLI stores a generated starter workflow.
With `--file`, it reads the file once and stores the source in `.wf/wf.sqlite`.
Use `--force` to replace an existing workflow id.

### `list`

List registered workflow artifacts:

```bash
wf list
```

### `run`

Run a registered workflow by id with optional JSON input:

```bash
wf run <workflow-id> [json-input]
```

Examples:

```bash
wf run welcome-email '{"message":"hello"}'
wf run email '{"id":"123","to":"hello@example.com"}'
```

If a workflow suspends waiting for a signal, the command records the pending
state, prints the signal name, the JSON Schema of the payload it expects, and a
copy-pasteable `signal` command with a sample payload, then exits 0.

### `signal`

Deliver a signal to a suspended run:

```bash
wf signal <run-id> <signal-name> [json-payload] [--actor <actor>]
```

Examples:

```bash
wf signal <run-id> approval '{"approved":true}'
wf signal <run-id> approval '{"approved":true}' --actor ops
```

### `runs`

List persisted workflow runs:

```bash
wf runs
```

### `history`

List persisted events for one run:

```bash
wf history <run-id>
```

### `help`

Print command help:

```bash
wf help
```

CLI state lives in `.wf/wf.sqlite`; durable engine state lives in `.wf/engine.sqlite`.

## Full-featured example

This workflow touches the full authoring surface: typed errors, retries,
concurrency, compensation, deterministic time/randomness, durable sleeps, and
signals ([examples/quickstart/order.ts](examples/quickstart/order.ts)):

```ts
import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

// Typed errors are tagged structs so the engine can persist and replay them.
const PaymentDeclined = t.taggedStruct("PaymentDeclined", { orderId: t.string })
const OrderRejected = t.taggedStruct("OrderRejected", { reason: t.string })

// A step is the unit of durable side effects: retried on thrown errors,
// its result persisted so replays never re-execute it.
const chargeCard = defineStep({
  name: "ChargeCard",
  input: t.struct({ orderId: t.string, amount: t.number }),
  output: t.struct({ paymentId: t.string }),
  errors: PaymentDeclined,
  retry: { attempts: 3, backoff: "none" },
  concurrency: { limit: 5 },
  execute: async (input, step) => {
    if (step.attempt < 2) {
      throw new Error("payment gateway flaked") // thrown errors are transient -> retried
    }
    if (input.amount <= 0) {
      return step.fail({ _tag: "PaymentDeclined", orderId: input.orderId }) // terminal -> never retried
    }
    console.log(`charged order ${input.orderId} on attempt ${step.attempt}`)
    return { paymentId: `pay_${input.orderId}` }
  },
  // Runs in reverse order if a later part of the workflow fails.
  compensate: async (result) => {
    console.log(`refunding ${result.paymentId}`)
  }
})

const shipOrder = defineStep({
  name: "ShipOrder",
  input: t.struct({ orderId: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(`shipped order ${input.orderId}`)
  }
})

export const OrderWorkflow = defineWorkflow({
  name: "OrderWorkflow",
  version: 1,
  input: t.struct({ orderId: t.string, amount: t.number }),
  output: t.struct({ paymentId: t.string }),
  errors: t.union([PaymentDeclined, OrderRejected]),
  run: function* (input, ctx) {
    // Durable step call: result is persisted, replays skip re-execution.
    const payment = yield* ctx.run(chargeCard, input)

    // Raw TypeScript sections can be made visible and durable with ctx.code.
    const auditLabel = yield* ctx.code("build-audit-label", {
      reason: "Combine the order and payment ids for operator-friendly logs",
      run: () => `${input.orderId}:${payment.paymentId}`
    })
    console.log(`audit label: ${auditLabel}`)

    // Time and randomness must go through ctx so replays see the same values.
    // (This log line prints once per resume — the workflow body replays after
    // each suspension, but the recorded values never change.)
    const placedAt = yield* ctx.now()
    const luckyDiscount = (yield* ctx.random()) < 0.1
    console.log(`order placed at ${placedAt.toISOString()}, lucky discount: ${luckyDiscount}`)

    // Durable timer: survives process restarts.
    yield* ctx.sleep("2 seconds", "cooldown")

    // Human-in-the-loop: suspend until an external signal arrives (or time out).
    const approval = yield* ctx.waitForSignal(
      "managerApproval",
      t.struct({ approved: t.boolean }),
      { timeout: "1 minute" }
    )
    if (approval.type === "timeout" || !approval.value.approved) {
      // Typed workflow failure: compensations run (chargeCard refunds).
      return yield* ctx.fail({ _tag: "OrderRejected", reason: "not approved" })
    }

    yield* ctx.run(shipOrder, { orderId: input.orderId })
    return { paymentId: payment.paymentId }
  }
})
```

### Parallel composition

Use `ctx.all([...], { name, concurrency })` like `Promise.all` for independent
workflow calls. Results are tuple-typed and returned in array order:

```ts
const [payment, inventory] = yield* ctx.all([
  ctx.run(chargeCard, input),
  ctx.run(reserveInventory, input)
], { name: "reserve-order", concurrency: "unbounded" })
```

The durable engine runs branches with Effect concurrency, and activity results are
persisted by activity name, so completion order does not affect replay. The
in-memory runner executes branches sequentially in array order; it is optimized
for tests and graph tracing, where deterministic branch boundaries are more
useful than actual parallelism.

Each branch should be a single pre-built orchestration call such as `ctx.run`,
`ctx.code`, `ctx.sleep`, or `ctx.waitForSignal`. Building additional `ctx.*`
calls dynamically inside a branch, for example with `Effect.flatMap`, assigns
invocation counters during interleaved durable execution and is not replay-safe
yet. Sequencing inside a branch will be modeled with child workflows later.

Inside a durable `ctx.all`, replay checks use call identity instead of global
journal position because concurrent branches can interleave differently across
runs. This still verifies matching branch calls by kind, name, counter, and the
outer `ctx.all` branch count, but divergence detection inside parallel blocks is
coarser than in sequential workflow code.

### Raw TypeScript sections

Use `ctx.code(name, { reason, run })` for pure TypeScript work between orchestration
calls that should appear as a first-class workflow node. The optional `reason`
explains the intent in traces and graphs:

```ts
const subject = yield* ctx.code("build-subject", {
  reason: "Derive a friendly subject from the recipient's email local part",
  run: () => `Welcome, ${input.to.split("@")[0]}!`
})
```

The result is journaled, so replays reuse the recorded value. Return values must
be JSON-serializable. Keep `run` free of external side effects; use `defineStep`
for IO, service calls, and anything that needs retries or compensation.

Run it through the durable engine with the workflow client
([examples/quickstart/main.ts](examples/quickstart/main.ts)):

```ts
import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { OrderWorkflow } from "./order"

const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: ".wf/quickstart.sqlite" })
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

const handle = await client.start(OrderWorkflow, { orderId: "123", amount: 42 })

// Approve the order once the workflow suspends on the managerApproval signal.
const waitingForApproval = async () => {
  const history = await client.history(handle.executionId)
  return history.some((record) => record.event.type === "signal.waiting" && record.event.name === "managerApproval")
}
while (!(await waitingForApproval())) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await client.signal(handle.executionId, "managerApproval", { approved: true }, { actor: "manager" })

const result = await client.result(handle.executionId)
console.log("result:", result)

// The engine's SQLite connection keeps the event loop alive.
process.exit(0)
```

```bash
bun run example:quickstart
```

The client also exposes `status`, `history`, and cancellation; because all
engine state lives in SQLite, a new process pointed at the same database can
deliver the signal and resume a suspended execution.

## Testing workflows

`createTestRuntime` (from `@mokronos/wfkit/testing`) and `workflow.executeInMemory` run
workflows without the engine, with hooks to fake steps, sleeps, signal
timeouts, and secrets. `deliverSignal(executionId, name, payload)` feeds
signals to in-memory executions.

```bash
bun test
```

## Storage

- `.wf/wf.sqlite` — CLI catalog: workflow source, run rows, event rows.
- `.wf/engine.sqlite` — durable engine state: completed activity results,
  timers, and suspended signal waits.

## Development

```bash
bun run typecheck
bun test
```
