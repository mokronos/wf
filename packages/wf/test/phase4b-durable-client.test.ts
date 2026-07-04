import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { createWorkflowClient, createWorkflowRuntime, defineWorkflow } from "../src"

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
})
