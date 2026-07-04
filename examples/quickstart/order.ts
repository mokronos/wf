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
