# wf

Durable workflows in plain TypeScript. You author workflows with typed inputs,
outputs, and errors; the engine (built on `@effect/workflow`) persists every
step result, timer, and signal wait in SQLite, so executions replay
deterministically and survive process restarts. Authored workflows import only
from `wf` — never from `effect` directly.

## Install

```bash
bun install
```

## Quickstart

One workflow that touches the whole authoring surface
([examples/quickstart/order.ts](examples/quickstart/order.ts)):

```ts
import { defineStep, defineWorkflow, t } from "wf"

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

Run it through the durable engine with the workflow client
([examples/quickstart/main.ts](examples/quickstart/main.ts)):

```ts
import { createWorkflowClient, createWorkflowRuntime } from "wf"
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

For a workflow that needs no external signals, `run(workflow, payload)`
executes it engine-backed as a standalone script — see
[examples/email](examples/email):

```bash
bun run example:email
```

## Testing workflows

`createTestRuntime` (from `wf/testing`) and `workflow.executeInMemory` run
workflows without the engine, with hooks to fake steps, sleeps, signal
timeouts, and secrets. `deliverSignal(executionId, name, payload)` feeds
signals to in-memory executions.

```bash
bun test
```

## CLI

The CLI stores workflow source in a local SQLite catalog and runs the stored
source through the engine:

```bash
bun run cli -- create email --file examples/email/email.ts
bun run cli -- run email '{"id":"123","to":"hello@example.com"}'
bun run cli -- list             # stored workflow artifacts
bun run cli -- runs             # persisted executions
bun run cli -- events <run-id>  # step/sleep/signal events for one run
```

See [apps/cli/README.md](apps/cli/README.md) for the full reference.

## Storage

- `.wf/wf.sqlite` — CLI catalog: workflow source, run rows, event rows.
- `.wf/engine.sqlite` — durable engine state: completed activity results,
  timers, and suspended signal waits.

## Development

```bash
bun run typecheck
bun test
```
