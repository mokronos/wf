import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  createWorkflowClient,
  createWorkflowRuntime,
  defineStep,
  defineWorkflow,
  lifecycleRunRecords,
  parseWorkflowId
} from "../src"

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
  test("invalid input is rejected before a memory execution is created", async () => {
    const workflow = defineWorkflow({
      name: "validatedMemoryInput",
      input: Schema.String.check(Schema.isMinLength(1)),
      output: Schema.Void,
      run: function* () {}
    })
    const client = createWorkflowClient()

    await expect(client.start(workflow, "")).rejects.toThrow()
    expect(await client.executions()).toEqual([])
  })

  test("a disposed memory client rejects new executions", async () => {
    const workflow = defineWorkflow({
      name: "disposedMemoryClient",
      input: Schema.Void,
      output: Schema.Void,
      run: function* () {}
    })
    const client = createWorkflowClient()

    await expect(Promise.all([client.dispose(), client.dispose()])).resolves.toEqual([
      undefined,
      undefined
    ])
    await expect(client.start(workflow, undefined)).rejects.toThrow(
      "Workflow client has been disposed"
    )
  })

  test("memory client disposal releases its explicit runtime", async () => {
    const runtime = createWorkflowRuntime({ backend: "memory" })
    const client = createWorkflowClient(runtime)

    await client.dispose()
    expect(() => runtime.register([])).toThrow("Workflow runtime has been disposed")
  })

  test("pendingSignals reports waits and removes delivered waits", async () => {
    const workflow = defineWorkflow({
      name: "pendingSignalsMemory",
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
      expect.objectContaining({
        name: "approval",
        invocation: 1,
        activityName: "approval#1",
        // The pending wait advertises the payload shape a caller must send.
        payloadSchema: expect.objectContaining({
          type: "object",
          required: ["approved"],
          properties: expect.objectContaining({
            approved: expect.objectContaining({ type: "boolean" })
          })
        })
      })
    ])

    await client.signal(handle.executionId, "approval", { approved: true })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "approved"
    })
    expect(await client.pendingSignals(handle.executionId)).toEqual([])
    await expect(client.signal(handle.executionId, "approval", { approved: true })).rejects.toThrow(
      "is not waiting for signal approval"
    )
  })

  test("pendingSignals disambiguates sequential waits with the same name", async () => {
    const workflow = defineWorkflow({
      name: "pendingSignalsSequentialMemory",
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
      expect.objectContaining({
        name: "approval",
        invocation: 1,
        activityName: "approval#1"
      })
    ])

    await client.signal(handle.executionId, "approval", { ok: true })
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")
    expect(await client.pendingSignals(handle.executionId)).toEqual([
      expect.objectContaining({
        name: "approval",
        invocation: 2,
        activityName: "approval#2"
      })
    ])

    await client.signal(handle.executionId, "approval", { ok: true })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "done"
    })
    expect(await client.pendingSignals(handle.executionId)).toEqual([])
  })

  test("concurrent signal delivery cannot buffer a duplicate for the next wait", async () => {
    const workflow = defineWorkflow({
      name: "singleSignalClaim",
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ ok: Schema.Boolean }))
        return signal.type
      }
    })
    const client = createWorkflowClient()
    const handle = await client.start(workflow, undefined)
    expect(await waitForStatus(client, handle.executionId, "suspended")).toBe("suspended")

    const deliveries = await Promise.allSettled([
      client.signal(handle.executionId, "approval", { ok: true }),
      client.signal(handle.executionId, "approval", { ok: true })
    ])
    expect(deliveries.filter((delivery) => delivery.status === "fulfilled")).toHaveLength(1)
    expect(deliveries.filter((delivery) => delivery.status === "rejected")).toHaveLength(1)
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "signal"
    })
  })

  test("fresh starts get distinct execution IDs; idempotencyKey deduplicates", async () => {
    const workflow = defineWorkflow({
      name: "freshStarts",
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

  test("list rejects malformed pagination", async () => {
    const workflow = defineWorkflow({
      name: "validatedPagination",
      input: Schema.Void,
      output: Schema.Void,
      run: function* () {}
    })
    const client = createWorkflowClient()

    await expect(client.list(workflow, { cursor: "not-an-offset" })).rejects.toThrow()
    await expect(client.list(workflow, { limit: 0 })).rejects.toThrow()
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

  test("hard cancellation interrupts an in-flight step", async () => {
    const neverCompletes = defineStep({
      name: "neverCompletes",
      input: Schema.Void,
      output: Schema.Void,
      execute: () => new Promise<never>(() => {})
    })
    const workflow = defineWorkflow({
      name: "hardCancelRunningStep",
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(neverCompletes, undefined)
      }
    })
    const client = createWorkflowClient()
    const handle = await client.start(workflow, undefined)

    await client.cancel(handle.executionId, { compensate: false })
    await expect(client.result(handle.executionId)).resolves.toMatchObject({
      type: "failed",
      error: { _tag: "Cancelled", compensate: false }
    })
  })

  test("status transitions include suspended during sleep and completed after result", async () => {
    const workflow = defineWorkflow({
      name: "statusWorkflow",
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

  test("lifecycle run projection matches name-only executions", async () => {
    const workflow = defineWorkflow({
      name: "workflowProjection",
      input: Schema.Void,
      output: Schema.String,
      run: function* () {
        return "ok"
      }
    })
    const client = createWorkflowClient()
    const handle = await client.start(workflow, undefined, { artifactId: "workflow-projection" })
    await client.result(handle.executionId)

    const runs = await lifecycleRunRecords(client, [
      {
        id: parseWorkflowId("workflow-projection"),
        source: "workflow source"
      }
    ])

    expect(runs).toContainEqual(
      expect.objectContaining({
        id: handle.executionId,
        workflowId: "workflow-projection"
      })
    )
  })
})
