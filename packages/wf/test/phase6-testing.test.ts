import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  defineStep,
  defineWorkflow,
  NonDeterminismError
} from "../src"
import { createTestRuntime } from "../src/testing"

const Approval = Schema.Struct({ approved: Schema.Boolean })
const Rejected = Schema.TaggedStruct("Rejected", { reason: Schema.String })

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

const waitForStatus = async (
  rt: ReturnType<typeof createTestRuntime>,
  executionId: string,
  expected: string
) => {
  for (let index = 0; index < 50; index++) {
    const status = await rt.status(executionId)
    if (status === expected) {
      return status
    }
    await delay(1)
  }
  return rt.status(executionId)
}

describe("Phase 6 test runtime", () => {
  test("spec-style saga test supports step mocks, signals, and compensation recording", async () => {
    const chargePayment = defineStep({
      name: "chargePayment",
      input: Schema.Struct({ amount: Schema.Number }),
      output: Schema.Struct({ transactionId: Schema.String }),
      execute: async () => ({ transactionId: "real-txn" }),
      compensate: async () => undefined
    })
    const reserveInventory = defineStep({
      name: "reserveInventory",
      input: Schema.Struct({ sku: Schema.String }),
      output: Schema.Struct({ reservationId: Schema.String }),
      retry: { attempts: 2, backoff: "none" },
      execute: async () => ({ reservationId: "real-reservation" })
    })
    const OrderWorkflow = defineWorkflow({
      name: "testOrder",
      version: 1,
      input: Schema.Struct({ totalAmount: Schema.Number, sku: Schema.String }),
      output: Schema.Struct({ transactionId: Schema.String }),
      errors: Rejected,
      run: function* (input, ctx) {
        const payment = yield* ctx.run(chargePayment, { amount: input.totalAmount })
        yield* ctx.waitForSignal("managerApproval", Approval, { timeout: "1 hour" })
        yield* ctx.run(reserveInventory, { sku: input.sku })
        return payment
      }
    })

    const rt = createTestRuntime()
    rt.mockStep(chargePayment, async () => ({ transactionId: "fake-txn" }))
    rt.mockStep(reserveInventory, async () => {
      throw new Error("out of stock")
    })

    const compensations = rt.recordCompensations()

    const exec = await rt.start(OrderWorkflow, { totalAmount: 42, sku: "sku-1" })

    await rt.sendSignal(exec.executionId, "managerApproval", { approved: true })

    const result = await rt.result(exec.executionId)

    expect(result.type).toBe("failed")
    expect(compensations.calls).toEqual([
      { step: "chargePayment", result: { transactionId: "fake-txn" } }
    ])
  })

  test("manual advanceTime controls sleeps and signal timeouts", async () => {
    const workflow = defineWorkflow({
      name: "manualClock",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.sleep("1 hour", "pause")
        const signal = yield* ctx.waitForSignal("approval", Approval, { timeout: "2 hours" })
        return signal.type
      }
    })
    const rt = createTestRuntime({ timeSkipping: false })
    const handle = await rt.start(workflow, {})

    expect(await waitForStatus(rt, handle.executionId, "suspended")).toBe("suspended")
    await rt.advanceTime("59 minutes")
    expect(await rt.status(handle.executionId)).toBe("suspended")
    await rt.advanceTime("1 minute")
    expect(await waitForStatus(rt, handle.executionId, "suspended")).toBe("suspended")
    await rt.sendSignal(handle.executionId, "approval", { approved: true })
    await expect(rt.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "signal"
    })
  })

  test("failStepOnce participates in the normal retry path", async () => {
    let attempts = 0
    const flaky = defineStep({
      name: "flaky",
      input: Schema.Struct({}),
      output: Schema.Number,
      retry: { attempts: 2, backoff: "none" },
      execute: async () => {
        attempts++
        return attempts
      }
    })
    const workflow = defineWorkflow({
      name: "retryHelper",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.Number,
      run: function* (_, ctx) {
        return yield* ctx.run(flaky, {})
      }
    })
    const rt = createTestRuntime()
    rt.failStepOnce(flaky)

    await expect(rt.result((await rt.start(workflow, {})).executionId)).resolves.toEqual({
      type: "completed",
      value: 1
    })
    expect(attempts).toBe(1)
  })

  test("cancel is exercisable and compensation policy is observable", async () => {
    const reserve = defineStep({
      name: "cancelReserve",
      input: Schema.String,
      output: Schema.String,
      execute: async (input) => `reserved:${input}`,
      compensate: async () => undefined
    })
    const workflow = defineWorkflow({
      name: "testRuntimeCancel",
      version: 1,
      input: Schema.String,
      output: Schema.String,
      run: function* (input, ctx) {
        yield* ctx.run(reserve, input)
        yield* ctx.waitForSignal("release", Schema.Struct({ ok: Schema.Boolean }))
        return "done"
      }
    })
    const rt = createTestRuntime()
    const recorder = rt.recordCompensations()

    const compensate = await rt.start(workflow, "a")
    expect(await waitForStatus(rt, compensate.executionId, "suspended")).toBe("suspended")
    await rt.cancel(compensate.executionId, { actor: "tester", compensate: true })
    expect(await rt.result(compensate.executionId)).toMatchObject({
      type: "failed",
      error: { _tag: "Cancelled" }
    })
    expect(recorder.calls).toEqual([{ step: "cancelReserve", result: "reserved:a" }])

    recorder.calls.length = 0
    const hard = await rt.start(workflow, "b")
    expect(await waitForStatus(rt, hard.executionId, "suspended")).toBe("suspended")
    await rt.cancel(hard.executionId, { actor: "tester", compensate: false })
    expect(await rt.result(hard.executionId)).toMatchObject({
      type: "failed",
      error: { _tag: "Cancelled" }
    })
    expect(recorder.calls).toEqual([])
  })

  test("divergence detector is exercisable through test runtime replay", async () => {
    const writes: string[] = []
    const first = defineStep({
      name: "firstTestRuntimeStep",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: async () => {
        writes.push("first")
        return {}
      }
    })
    const second = defineStep({
      name: "secondTestRuntimeStep",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: async () => {
        writes.push("second")
        return {}
      }
    })
    const original = defineWorkflow({
      name: "testRuntimeDivergence",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.run(first, {})
        return "original"
      }
    })
    const divergent = defineWorkflow({
      name: "testRuntimeDivergence",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        yield* ctx.run(second, {})
        return "divergent"
      }
    })
    const rt = createTestRuntime()
    const handle = await rt.start(original, {})
    await expect(rt.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "original"
    })
    writes.length = 0

    const replay = await rt.replay(handle.executionId, divergent, {})
    await expect(rt.result(replay.executionId)).resolves.toMatchObject({
      type: "failed",
      error: expect.any(NonDeterminismError)
    })
    expect(writes).toEqual([])
  })

  test("test runtime can simulate deterministic restart for now and random", async () => {
    const observed: Array<{ readonly now: Date; readonly random: number }> = []
    const before = defineStep({
      name: "beforeRestart",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: async () => ({})
    })
    const crash = defineWorkflow({
      name: "testRuntimeDeterminismRestart",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      run: function* (_, ctx) {
        yield* ctx.run(before, {})
        const now = yield* ctx.now()
        const random = yield* ctx.random()
        observed.push({ now, random })
        yield* ctx.effect(Effect.fail(new Error("crash")))
        return {}
      }
    })
    const resume = defineWorkflow({
      name: "testRuntimeDeterminismRestart",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.Struct({ nowMs: Schema.Number, random: Schema.Number }),
      run: function* (_, ctx) {
        yield* ctx.run(before, {})
        const now = yield* ctx.now()
        const random = yield* ctx.random()
        return { nowMs: now.getTime(), random }
      }
    })
    const rt = createTestRuntime()
    const crashed = await rt.start(crash, {})
    await expect(rt.result(crashed.executionId)).resolves.toMatchObject({ type: "failed" })

    const replay = await rt.replay(crashed.executionId, resume, {})
    await expect(rt.result(replay.executionId)).resolves.toEqual({
      type: "completed",
      value: {
        nowMs: observed[0]!.now.getTime(),
        random: observed[0]!.random
      }
    })
  })
})
