import { describe, expect, test } from "@effect/vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { createWorkflowClient, createWorkflowRuntime, defineStep, defineWorkflow } from "../src"

const dbPath = () => path.join(mkdtempSync(path.join(tmpdir(), "wf-phase8-")), "wf.sqlite")

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

const makeFixtures = () => {
  const compensated: string[] = []

  const reserve = defineStep({
    name: "reserve",
    input: Schema.Struct({ item: Schema.String }),
    output: Schema.Struct({ reservationId: Schema.String }),
    execute: async (input) => ({ reservationId: `res-${input.item}` }),
    compensate: async (result) => {
      compensated.push(result.reservationId)
    }
  })

  const workflow = defineWorkflow({
    name: "cancellableOrder",
    input: Schema.Struct({ item: Schema.String }),
    output: Schema.String,
    run: function* (input, ctx) {
      const reservation = yield* ctx.run(reserve, { item: input.item })
      const approval = yield* ctx.waitForSignal(
        "approval",
        Schema.Struct({ approved: Schema.Boolean })
      )
      return approval.type === "signal" && approval.value.approved
        ? reservation.reservationId
        : "rejected"
    }
  })

  return { workflow, compensated }
}

describe("Phase 8 durable cancellation", () => {
  test("cancel with compensate: true unwinds completed steps on the sqlite backend", async () => {
    const { workflow, compensated } = makeFixtures()
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { item: "widget" })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")

    await client.cancel(handle.executionId, { actor: "ops" })

    const result = await client.result(handle.executionId)
    expect(result.type).toBe("failed")
    expect(await client.status(handle.executionId)).toBe("failed")
    expect(compensated).toEqual(["res-widget"])

    const history = await client.history(handle.executionId)
    const types = history.map((record) => record.event.type)
    expect(types).toContain("execution.cancelled")
    expect(types).toContain("cancellation.received")
    expect(types).toContain("compensation.started")
    expect(types).toContain("compensation.completed")
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "execution.cancelled", actor: "ops" })
        })
      ])
    )
  })

  test("cancel with compensate: false hard-interrupts without unwinding", async () => {
    const { workflow, compensated } = makeFixtures()
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { item: "widget" })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")

    await client.cancel(handle.executionId, { compensate: false, actor: "ops" })

    expect(await client.status(handle.executionId)).toBe("failed")
    expect(await client.result(handle.executionId)).toEqual({
      type: "failed",
      error: expect.objectContaining({ _tag: "Cancelled", compensate: false })
    })
    expect((await client.execution(handle.executionId)).finishedAt).toBeDefined()
    expect(compensated).toEqual([])

    const history = await client.history(handle.executionId)
    const types = history.map((record) => record.event.type)
    expect(types).toContain("execution.cancelled")
    expect(types).not.toContain("compensation.started")
  })

  test("concurrent cancellation records only the request that claims the execution", async () => {
    const { workflow } = makeFixtures()
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)
    const handle = await client.start(workflow, { item: "widget" })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")

    const claimed = client.cancel(handle.executionId, { actor: "first" })
    await expect(client.cancel(handle.executionId, { actor: "second" })).rejects.toThrow(
      "Cannot cancel compensating"
    )
    await claimed

    const cancellations = (await client.history(handle.executionId)).filter(
      (record) => record.event.type === "execution.cancelled"
    )
    expect(cancellations).toHaveLength(1)
    expect(cancellations[0]?.event).toMatchObject({ actor: "first" })
  })

  test("timed signal wait still receives its signal (durable race regression)", async () => {
    const workflow = defineWorkflow({
      name: "timedWait",
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        const approval = yield* ctx.waitForSignal(
          "approval",
          Schema.Struct({ approved: Schema.Boolean }),
          { timeout: "30 seconds" }
        )
        if (approval.type === "timeout") {
          return "timeout"
        }
        return approval.value.approved ? "approved" : "rejected"
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, undefined)
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    await client.signal(handle.executionId, "approval", { approved: true })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "approved"
    })
  })

  test("does not overwrite a completed execution with cancellation", async () => {
    const workflow = defineWorkflow({
      name: "alreadyCompleted",
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        return yield* ctx.effect(Effect.succeed("done"))
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, {})
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "done"
    })
    await expect(client.cancel(handle.executionId)).rejects.toThrow("Cannot cancel completed")
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "done"
    })
  })
})
