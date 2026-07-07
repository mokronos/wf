import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { createWorkflowClient, createWorkflowRuntime, defineStep, defineWorkflow } from "../src"

const dbPath = () => path.join(mkdtempSync(path.join(tmpdir(), "wf-phase4b-")), "wf.sqlite")

const waitForStatus = async (
  client: ReturnType<typeof createWorkflowClient>,
  executionId: string,
  expected: string
) => {
  for (let index = 0; index < 100; index++) {
    const status = await client.status(executionId)
    if (status === expected) {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return client.status(executionId)
}

const waitForHistoryEvent = async (
  client: ReturnType<typeof createWorkflowClient>,
  executionId: string,
  type: string
) => {
  for (let index = 0; index < 100; index++) {
    const history = await client.history(executionId)
    if (history.some((record) => record.event.type === type)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for history event ${type}`)
}

const withTimeout = async <A>(promise: Promise<A>, ms: number): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

describe("Phase 4b durable workflow client", () => {
  test("sqlite backend uses fresh execution IDs and explicit idempotency", async () => {
    const workflow = defineWorkflow({
      name: "sqliteIdentity",
      version: 1,
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      run: function* (input) {
        return input.value
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const first = await client.start(workflow, { value: "same" })
    const second = await client.start(workflow, { value: "same" })
    expect(first.executionId).not.toBe(second.executionId)

    const keyedFirst = await client.start(workflow, { value: "same" }, { idempotencyKey: "same" })
    const keyedSecond = await client.start(workflow, { value: "same" }, { idempotencyKey: "same" })
    expect(keyedSecond).toEqual(keyedFirst)

    await expect(client.result(first.executionId)).resolves.toEqual({ type: "completed", value: "same" })
    await expect(client.result(second.executionId)).resolves.toEqual({ type: "completed", value: "same" })
    await expect(client.result(keyedFirst.executionId)).resolves.toEqual({ type: "completed", value: "same" })
  })

  test("sqlite backend lifecycle: start, durable sleep, suspend on signal, deliver, result", async () => {
    const workflow = defineWorkflow({
      name: "sqliteLifecycle",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.sleep("10 millis", "shortPause")
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ approved: Schema.Boolean }))
        return signal.type === "signal" && signal.value.approved ? "approved" : "rejected"
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, {}, { actor: "tester" })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    await waitForHistoryEvent(client, handle.executionId, "signal.waiting")
    await client.signal(handle.executionId, "approval", { approved: true }, { actor: "manager" })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "approved"
    })
    expect(await client.status(handle.executionId)).toBe("completed")
    expect(await client.history(handle.executionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "execution.started", actor: "tester" })
        }),
        expect.objectContaining({
          event: expect.objectContaining({ type: "sleep.started" })
        }),
        expect.objectContaining({
          event: expect.objectContaining({ type: "signal.delivered", actor: "manager" })
        })
      ])
    )
  })

  test("sqlite backend single-flights overlapping start and result execution", async () => {
    const slowStep = defineStep({
      name: "sqliteSingleFlightStep",
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      execute: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return input.value
      }
    })
    const workflow = defineWorkflow({
      name: "sqliteSingleFlightWorkflow",
      version: 1,
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      run: function* (input, ctx) {
        return yield* ctx.run(slowStep, input)
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { value: "done" })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "done"
    })

    const startedEvents = (await client.history(handle.executionId)).filter(
      (record) => record.event.type === "workflow.started"
    )
    expect(startedEvents).toHaveLength(1)
  })

  test("sqlite backend completes ctx.all branches with tuple results", async () => {
    const charge = defineStep({
      name: "sqliteAllCharge",
      input: Schema.Struct({ orderId: Schema.String }),
      output: Schema.Struct({ paymentId: Schema.String }),
      execute: async (input) => ({ paymentId: `pay-${input.orderId}` })
    })
    const reserve = defineStep({
      name: "sqliteAllReserve",
      input: Schema.Struct({ orderId: Schema.String }),
      output: Schema.Struct({ reservationId: Schema.String }),
      execute: async (input) => ({ reservationId: `res-${input.orderId}` })
    })
    const workflow = defineWorkflow({
      name: "sqliteAllWorkflow",
      version: 1,
      input: Schema.Struct({ orderId: Schema.String }),
      output: Schema.Struct({
        paymentId: Schema.String,
        reservationId: Schema.String
      }),
      run: function* (input, ctx) {
        const [payment, inventory] = yield* ctx.all([
          ctx.run(charge, input),
          ctx.run(reserve, input)
        ], { name: "parallel" })
        return {
          paymentId: payment.paymentId,
          reservationId: inventory.reservationId
        }
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { orderId: "123" })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: { paymentId: "pay-123", reservationId: "res-123" }
    })
    const history = await client.history(handle.executionId)
    expect(history.map((record) => record.event.type)).toEqual(
      expect.arrayContaining(["all.started", "all.completed", "step.completed"])
    )
  })

  test("sqlite backend pendingSignals excludes timeout-consumed waits", async () => {
    const workflow = defineWorkflow({
      name: "sqlitePendingSignalTimeout",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ approved: Schema.Boolean }), {
          timeout: "1 millis"
        })
        return signal.type === "timeout" ? "timed-out" : "signaled"
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, {})
    await waitForHistoryEvent(client, handle.executionId, "signal.waiting")
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "timed-out"
    })
    expect(await client.pendingSignals(handle.executionId)).toEqual([])
  })

  test("sqlite backend can resume a suspended signal wait from a new runtime over the same file", async () => {
    const workflow = defineWorkflow({
      name: "sqliteRestart",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ approved: Schema.Boolean }))
        return signal.type === "signal" && signal.value.approved ? "resumed" : "rejected"
      }
    })
    const databasePath = dbPath()
    const runtime1 = createWorkflowRuntime({ backend: "sqlite", databasePath })
    runtime1.register([workflow])
    const client1 = createWorkflowClient(runtime1)

    const handle = await client1.start(workflow, {})
    expect(await waitForStatus(client1, handle.executionId, "suspended")).toBe("suspended")
    await waitForHistoryEvent(client1, handle.executionId, "signal.waiting")

    const runtime2 = createWorkflowRuntime({ backend: "sqlite", databasePath })
    runtime2.register([workflow])
    const client2 = createWorkflowClient(runtime2)

    await client2.signal(handle.executionId, "approval", { approved: true })
    await expect(client2.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "resumed"
    })
  })

  test("sqlite backend retries exponential step failures to completion", async () => {
    let attempts = 0
    const flaky = defineStep({
      name: "sqliteExponentialRetry",
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String, attempts: Schema.Number }),
      retry: { attempts: 3, backoff: "exponential" },
      execute: async (input) => {
        attempts++
        if (attempts < 3) {
          throw new Error(`transient ${attempts}`)
        }
        return { id: input.id, attempts }
      }
    })
    const workflow = defineWorkflow({
      name: "sqliteExponentialRetryWorkflow",
      version: 1,
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Struct({ id: Schema.String, attempts: Schema.Number }),
      run: function* (input, ctx) {
        return yield* ctx.run(flaky, input)
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { id: "retry-1" })
    await expect(withTimeout(client.result(handle.executionId), 3_000)).resolves.toEqual({
      type: "completed",
      value: { id: "retry-1", attempts: 3 }
    })
    const failedAttempts = (await client.history(handle.executionId)).filter(
      (record) => record.event.type === "step.failed"
    )
    expect(failedAttempts).toHaveLength(2)
  })
})
