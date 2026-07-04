import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineStep, defineWorkflow } from "../src/core"

const Rejected = Schema.TaggedStruct("Rejected", {
  reason: Schema.String
})

const Boom = Schema.TaggedStruct("Boom", {
  message: Schema.String
})

describe("Phase 1 authoring model", () => {
  test("ported OrderWorkflow shape typechecks with inferred ctx.run results and ctx.fail", async () => {
    const chargePayment = defineStep({
      name: "chargePayment",
      input: Schema.Struct({ amount: Schema.Number, customerId: Schema.String }),
      output: Schema.Struct({ transactionId: Schema.String }),
      execute: async (input) => ({
        transactionId: `${input.customerId}:${input.amount}`
      })
    })

    const reserveInventory = defineStep({
      name: "reserveInventory",
      input: Schema.Struct({ items: Schema.Array(Schema.String) }),
      output: Schema.Struct({ reservationId: Schema.String }),
      execute: async (input) => ({
        reservationId: input.items.join(",")
      })
    })

    const OrderWorkflow = defineWorkflow({
      name: "processOrder",
      version: 1,
      input: Schema.Struct({
        orderId: Schema.String,
        totalAmount: Schema.Number,
        customerId: Schema.String,
        items: Schema.Array(Schema.String),
        approved: Schema.Boolean
      }),
      output: Schema.Struct({ orderId: Schema.String, paymentId: Schema.String }),
      errors: Rejected,
      run: function* (payload, ctx) {
        const payment = yield* ctx.run(chargePayment, {
          amount: payload.totalAmount,
          customerId: payload.customerId
        })
        yield* ctx.run(reserveInventory, { items: payload.items })

        if (!payload.approved) {
          return yield* ctx.fail({ _tag: "Rejected", reason: "no approval" })
        }

        return { orderId: payload.orderId, paymentId: payment.transactionId }
      }
    })

    await expect(
      OrderWorkflow.executeInMemory({
        orderId: "ord_1",
        totalAmount: 10,
        customerId: "cus_1",
        items: ["sku_1"],
        approved: true
      })
    ).resolves.toEqual({ orderId: "ord_1", paymentId: "cus_1:10" })
  })

  test("calling one step twice and in a loop records distinct invocation counters", async () => {
    const events: unknown[] = []
    const echo = defineStep({
      name: "echo",
      input: Schema.Struct({ value: Schema.Number }),
      output: Schema.Number,
      execute: async (input) => input.value
    })

    const workflow = defineWorkflow({
      name: "counterWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Array(Schema.Number),
      run: function* (_, ctx) {
        const values: number[] = []
        values.push(yield* ctx.run(echo, { value: 1 }))
        values.push(yield* ctx.run(echo, { value: 2 }))
        for (let index = 0; index < 3; index++) {
          values.push(yield* ctx.run(echo, { value: index + 3 }))
        }
        return values
      }
    })

    await expect(
      workflow.executeInMemory(undefined, {
        onEvent: (event) => {
          events.push(event)
        }
      })
    )
      .resolves.toEqual([1, 2, 3, 4, 5])

    const completed = events.filter(
      (event): event is { readonly type: "step.completed"; readonly activityName: string } =>
        typeof event === "object" &&
        event !== null &&
        (event as { readonly type?: unknown }).type === "step.completed"
    )
    expect(completed.map((event) => event.activityName)).toEqual([
      "echo#1",
      "echo#2",
      "echo#3",
      "echo#4",
      "echo#5"
    ])
  })

  test("ctx.sleep applies invocation counters to omitted and repeated names", async () => {
    const events: unknown[] = []
    const workflow = defineWorkflow({
      name: "sleepCounterWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.sleep("1 second")
        yield* ctx.sleep("1 second")
        yield* ctx.sleep("1 second", "pause")
        yield* ctx.sleep("1 second", "pause")
      }
    })

    await workflow.executeInMemory(undefined, {
      onEvent: (event) => {
        events.push(event)
      }
    })

    const started = events.filter(
      (event): event is { readonly type: "sleep.started"; readonly activityName: string } =>
        typeof event === "object" &&
        event !== null &&
        (event as { readonly type?: unknown }).type === "sleep.started"
    )
    expect(started.map((event) => event.activityName)).toEqual([
      "sleep:1 second#1",
      "sleep:1 second#2",
      "pause#1",
      "pause#2"
    ])
  })

  test("thrown transient errors retry up to attempts and step.fail never retries", async () => {
    let transientCalls = 0
    const transient = defineStep({
      name: "transient",
      input: Schema.Void,
      output: Schema.Void,
      retry: { attempts: 3, backoff: "none" },
      execute: async () => {
        transientCalls++
        throw new Error("temporary")
      }
    })

    const transientWorkflow = defineWorkflow({
      name: "transientWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(transient, undefined)
      }
    })

    await expect(transientWorkflow.executeInMemory(undefined)).rejects.toThrow("temporary")
    expect(transientCalls).toBe(3)

    let terminalCalls = 0
    const terminal = defineStep({
      name: "terminal",
      input: Schema.Void,
      output: Schema.Void,
      errors: Boom,
      retry: { attempts: 3, backoff: "none" },
      execute: async (_, step) => {
        terminalCalls++
        return step.fail({ _tag: "Boom", message: "done" })
      }
    })

    const terminalWorkflow = defineWorkflow({
      name: "terminalWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(terminal, undefined)
      }
    })

    await expect(terminalWorkflow.executeInMemory(undefined)).rejects.toEqual({
      _tag: "Boom",
      message: "done"
    })
    expect(terminalCalls).toBe(1)
  })

  test("terminal failure after two successful steps compensates LIFO with result input and reason", async () => {
    const calls: unknown[] = []

    const first = defineStep({
      name: "first",
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ result: Schema.String }),
      execute: async (input) => ({ result: `first:${input.value}` }),
      compensate: async (result, input, reason) => {
        calls.push({ step: "first", result, input, reason })
      }
    })

    const second = defineStep({
      name: "second",
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ result: Schema.String }),
      execute: async (input) => ({ result: `second:${input.value}` }),
      compensate: async (result, input, reason) => {
        calls.push({ step: "second", result, input, reason })
      }
    })

    const noCompensation = defineStep({
      name: "noCompensation",
      input: Schema.Void,
      output: Schema.Void,
      execute: async () => undefined
    })

    const workflow = defineWorkflow({
      name: "compensationWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      errors: Rejected,
      run: function* (_, ctx) {
        yield* ctx.run(first, { value: "a" })
        yield* ctx.run(second, { value: "b" })
        yield* ctx.run(noCompensation, undefined)
        return yield* ctx.fail({ _tag: "Rejected", reason: "stop" })
      }
    })

    await expect(workflow.executeInMemory(undefined)).rejects.toEqual({
      _tag: "Rejected",
      reason: "stop"
    })

    expect(calls).toEqual([
      {
        step: "second",
        result: { result: "second:b" },
        input: { value: "b" },
        reason: { _tag: "Rejected", reason: "stop" }
      },
      {
        step: "first",
        result: { result: "first:a" },
        input: { value: "a" },
        reason: { _tag: "Rejected", reason: "stop" }
      }
    ])
  })
})
