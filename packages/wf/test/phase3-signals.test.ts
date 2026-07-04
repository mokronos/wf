import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { defineStep, defineWorkflow } from "../src/core"
import { deliverSignal, SignalDeliveryError } from "../src/signal"

const Approval = Schema.Struct({ approved: Schema.Boolean })
const Rejected = Schema.TaggedStruct("Rejected", { reason: Schema.String })

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Phase 3 signals v2", () => {
  test("HITL approval completes; timeout branches through ctx.fail and compensates", async () => {
    const compensations: unknown[] = []

    const charge = defineStep({
      name: "charge",
      input: Schema.Struct({ orderId: Schema.String }),
      output: Schema.Struct({ paymentId: Schema.String }),
      execute: async (input) => ({ paymentId: `pay_${input.orderId}` }),
      compensate: async (result, input, reason) => {
        compensations.push({ result, input, reason })
      }
    })

    const workflow = defineWorkflow({
      name: "approvalWorkflow",
      version: 1,
      input: Schema.Struct({ orderId: Schema.String }),
      output: Schema.Struct({ paymentId: Schema.String }),
      errors: Rejected,
      run: function* (input, ctx) {
        const payment = yield* ctx.run(charge, { orderId: input.orderId })
        const approval = yield* ctx.waitForSignal("managerApproval", Approval, {
          timeout: "48 hours"
        })

        if (approval.type === "timeout" || !approval.value.approved) {
          return yield* ctx.fail({ _tag: "Rejected", reason: "no approval" })
        }

        return { paymentId: payment.paymentId }
      }
    })

    await deliverSignal("hitl-approved", "managerApproval", { approved: true })
    await expect(
      workflow.executeInMemory({ orderId: "1" }, { executionId: "hitl-approved" })
    ).resolves.toEqual({ paymentId: "pay_1" })
    expect(compensations).toEqual([])

    await expect(
      workflow.executeInMemory({ orderId: "2" }, { executionId: "hitl-timeout" })
    ).rejects.toEqual({ _tag: "Rejected", reason: "no approval" })
    expect(compensations).toEqual([
      {
        result: { paymentId: "pay_2" },
        input: { orderId: "2" },
        reason: { _tag: "Rejected", reason: "no approval" }
      }
    ])
  })

  test("signal delivered before waitForSignal is buffered and consumed", async () => {
    const workflow = defineWorkflow({
      name: "preSignalWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Boolean,
      run: function* (_, ctx) {
        const approval = yield* ctx.waitForSignal("approval", Approval, {
          timeout: "1 hour"
        })
        return approval.type === "signal" && approval.value.approved
      }
    })

    await deliverSignal("pre-signal", "approval", { approved: true })
    await expect(workflow.executeInMemory(undefined, { executionId: "pre-signal" }))
      .resolves.toBe(true)
  })

  test("reminder loop records distinct reminder step counters before signal", async () => {
    const events: unknown[] = []
    const reminder = defineStep({
      name: "sendReminder",
      input: Schema.Struct({ count: Schema.Number }),
      output: Schema.Void,
      execute: async (input, step) => {
        if (input.count === 3) {
          await deliverSignal(step.executionId, "approval", { approved: true })
        }
      }
    })

    const workflow = defineWorkflow({
      name: "reminderWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Number,
      run: function* (_, ctx) {
        let reminders = 0
        while (true) {
          const approval = yield* ctx.waitForSignal("approval", Approval, {
            timeout: "24 hours"
          })
          if (approval.type === "signal") {
            return reminders
          }
          reminders++
          yield* ctx.run(reminder, { count: reminders })
        }
      }
    })

    await expect(
      workflow.executeInMemory(undefined, {
        executionId: "reminder-loop",
        onEvent: (event) => {
          events.push(event)
        }
      })
    ).resolves.toBe(3)

    const completed = events.filter(
      (event): event is { readonly type: "step.completed"; readonly activityName: string } =>
        typeof event === "object" &&
        event !== null &&
        (event as { readonly type?: unknown }).type === "step.completed"
    )
    expect(completed.map((event) => event.activityName)).toEqual([
      "sendReminder#1",
      "sendReminder#2",
      "sendReminder#3"
    ])
  })

  test("invalid signal payload is rejected at delivery and does not resume workflow", async () => {
    const workflow = defineWorkflow({
      name: "validationWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Boolean,
      run: function* (_, ctx) {
        const approval = yield* ctx.waitForSignal("approval", Approval)
        return approval.type === "signal" && approval.value.approved
      }
    })

    let settled = false
    const result = workflow
      .executeInMemory(undefined, { executionId: "signal-validation" })
      .then((value) => {
        settled = true
        return value
      })

    await delay(0)
    await expect(deliverSignal("signal-validation", "approval", { approved: "yes" }))
      .rejects.toThrow(SignalDeliveryError)
    await delay(0)
    expect(settled).toBe(false)

    await deliverSignal("signal-validation", "approval", { approved: true })
    await expect(result).resolves.toBe(true)
  })
})
