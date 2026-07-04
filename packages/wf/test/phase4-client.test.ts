import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createWorkflowClient, defineStep, defineWorkflow } from "../src"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForStatus = async (
  client: ReturnType<typeof createWorkflowClient>,
  executionId: string,
  expected: string
) => {
  for (let index = 0; index < 20; index++) {
    const status = await client.status(executionId)
    if (status === expected) {
      return status
    }
    await delay(1)
  }
  return client.status(executionId)
}

describe("Phase 4 workflow client", () => {
  test("pendingSignals reports waits and removes delivered waits", async () => {
    const workflow = defineWorkflow({
      name: "pendingSignalsMemory",
      version: 1,
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ approved: Schema.Boolean }))
        return signal.type === "signal" && signal.value.approved ? "approved" : "rejected"
      }
    })
    const client = createWorkflowClient()

    const handle = await client.start(workflow, undefined)
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    expect(await client.pendingSignals(handle.executionId)).toEqual([
      {
        name: "approval",
        invocation: 1,
        activityName: "approval#1"
      }
    ])

    await client.signal(handle.executionId, "approval", { approved: true })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "approved"
    })
    expect(await client.pendingSignals(handle.executionId)).toEqual([])
  })

  test("pendingSignals disambiguates sequential waits with the same name", async () => {
    const workflow = defineWorkflow({
      name: "pendingSignalsSequentialMemory",
      version: 1,
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.waitForSignal("approval", Schema.Struct({ ok: Schema.Boolean }))
        yield* ctx.waitForSignal("approval", Schema.Struct({ ok: Schema.Boolean }))
        return "done"
      }
    })
    const client = createWorkflowClient()

    const handle = await client.start(workflow, undefined)
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    expect(await client.pendingSignals(handle.executionId)).toEqual([
      {
        name: "approval",
        invocation: 1,
        activityName: "approval#1"
      }
    ])

    await client.signal(handle.executionId, "approval", { ok: true })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    expect(await client.pendingSignals(handle.executionId)).toEqual([
      {
        name: "approval",
        invocation: 2,
        activityName: "approval#2"
      }
    ])

    await client.signal(handle.executionId, "approval", { ok: true })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "done"
    })
    expect(await client.pendingSignals(handle.executionId)).toEqual([])
  })

  test("fresh starts get distinct execution IDs; idempotencyKey deduplicates", async () => {
    const workflow = defineWorkflow({
      name: "freshStarts",
      version: 1,
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      run: function* (input) {
        return input.value
      }
    })
    const client = createWorkflowClient()

    const first = await client.start(workflow, { value: "same" })
    const second = await client.start(workflow, { value: "same" })
    expect(first.executionId).not.toBe(second.executionId)

    const keyedFirst = await client.start(workflow, { value: "same" }, { idempotencyKey: "same" })
    const keyedSecond = await client.start(workflow, { value: "same" }, { idempotencyKey: "same" })
    expect(keyedSecond).toEqual(keyedFirst)
  })

  test("cancel during signal wait records actor and compensation behavior", async () => {
    const compensated: string[] = []
    const reserve = defineStep({
      name: "reserve",
      input: Schema.String,
      output: Schema.String,
      execute: async (input) => `reserved:${input}`,
      compensate: async (result) => {
        compensated.push(result)
      }
    })

    const workflow = defineWorkflow({
      name: "cancelWorkflow",
      version: 1,
      input: Schema.String,
      output: Schema.String,
      run: function* (input, ctx) {
        yield* ctx.run(reserve, input)
        yield* ctx.waitForSignal("release", Schema.Struct({ ok: Schema.Boolean }))
        return "done"
      }
    })

    const client = createWorkflowClient()
    const withCompensation = await client.start(workflow, "a")
    expect(await waitForStatus(client, withCompensation.executionId, "suspended")).toBe("suspended")
    await client.cancel(withCompensation.executionId, { actor: "ops", compensate: true })
    expect(await client.result(withCompensation.executionId)).toMatchObject({
      type: "failed",
      error: { _tag: "Cancelled" }
    })
    expect(compensated).toEqual(["reserved:a"])
    expect(await client.history(withCompensation.executionId)).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "execution.cancelled",
          actor: "ops",
          compensate: true
        })
      })
    )

    compensated.length = 0
    const hard = await client.start(workflow, "b")
    expect(await waitForStatus(client, hard.executionId, "suspended")).toBe("suspended")
    await client.cancel(hard.executionId, { actor: "ops", compensate: false })
    expect(await client.result(hard.executionId)).toMatchObject({
      type: "failed",
      error: { _tag: "Cancelled" }
    })
    expect(compensated).toEqual([])
    expect(await client.history(hard.executionId)).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "execution.cancelled",
          actor: "ops",
          compensate: false
        })
      })
    )
  })

  test("status transitions include suspended during sleep and completed after result", async () => {
    const workflow = defineWorkflow({
      name: "statusWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.sleep("1 second", "pause")
        return "ok"
      }
    })
    const client = createWorkflowClient()

    const handle = await client.start(workflow, undefined)
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "ok"
    })
    expect(await client.status(handle.executionId)).toBe("completed")

    const listed = await client.list(workflow, { status: "completed", limit: 1 })
    expect(listed.executions).toHaveLength(1)
    expect(listed.executions[0]!.executionId).toBe(handle.executionId)
    expect(await client.history(handle.executionId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "sleep.started" })
        }),
        expect.objectContaining({
          event: expect.objectContaining({ type: "sleep.completed" })
        })
      ])
    )
  })
})
