import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

// The payload a human reviewer sends to resume the workflow.
export const ApprovalDecision = t.struct({
  approved: t.boolean,
  approver: t.string,
  comment: t.optional(t.string)
})

const ApprovalRejectedError = t.taggedStruct("ApprovalRejectedError", {
  requestId: t.string,
  approver: t.string,
  comment: t.optional(t.string)
})

const reserveBudget = defineStep({
  name: "ReserveBudget",
  input: t.struct({ requestId: t.string, amountCents: t.number }),
  output: t.struct({ holdId: t.string }),
  execute: async (input) => {
    console.log(`[budget] holding ${input.amountCents} cents for ${input.requestId}`)
    return { holdId: `hold-${input.requestId}` }
  },
  compensate: async (result) => {
    console.log(`[budget] released ${result.holdId}`)
  }
})

const notifyApprover = defineStep({
  name: "NotifyApprover",
  input: t.struct({ requestId: t.string, requester: t.string, amountCents: t.number }),
  output: t.void,
  execute: async (input) => {
    console.log(
      `[inbox] ${input.requester} requests ${input.amountCents} cents (${input.requestId}) — waiting for a human decision`
    )
  }
})

const escalateToManager = defineStep({
  name: "EscalateToManager",
  input: t.struct({ requestId: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(`[inbox] request ${input.requestId} escalated to manager after review timeout`)
  }
})

const postToLedger = defineStep({
  name: "PostToLedger",
  input: t.struct({ requestId: t.string, holdId: t.string, amountCents: t.number, approver: t.string }),
  output: t.struct({ entryId: t.string }),
  execute: async (input) => {
    console.log(`[ledger] booked ${input.amountCents} cents for ${input.requestId} (approved by ${input.approver})`)
    return { entryId: `entry-${input.requestId}` }
  }
})

export const ExpenseApprovalWorkflow = defineWorkflow({
  name: "ExpenseApprovalWorkflow",
  version: 1,
  input: t.struct({
    requestId: t.string,
    requester: t.string,
    amountCents: t.number,
    // Milliseconds the first review may take before the request escalates.
    // Omit it to wait for the human indefinitely.
    reviewTimeoutMillis: t.optional(t.number)
  }),
  output: t.struct({
    status: t.literal("approved"),
    approver: t.string,
    entryId: t.string
  }),
  errors: ApprovalRejectedError,
  run: function* (input, ctx) {
    const hold = yield* ctx.run(reserveBudget, {
      requestId: input.requestId,
      amountCents: input.amountCents
    })

    yield* ctx.run(notifyApprover, {
      requestId: input.requestId,
      requester: input.requester,
      amountCents: input.amountCents
    })

    let decision = yield* ctx.waitForSignal(
      "approval",
      ApprovalDecision,
      input.reviewTimeoutMillis === undefined ? undefined : { timeout: input.reviewTimeoutMillis }
    )

    if (decision.type === "timeout") {
      yield* ctx.run(escalateToManager, { requestId: input.requestId })
      decision = yield* ctx.waitForSignal("approval", ApprovalDecision)
    }

    if (decision.type !== "signal") {
      // Unreachable: the escalated wait has no timeout.
      throw new Error("approval wait ended without a decision")
    }

    if (!decision.value.approved) {
      yield* ctx.fail({
        _tag: "ApprovalRejectedError",
        requestId: input.requestId,
        approver: decision.value.approver,
        ...(decision.value.comment === undefined ? {} : { comment: decision.value.comment })
      })
    }

    const entry = yield* ctx.run(postToLedger, {
      requestId: input.requestId,
      holdId: hold.holdId,
      amountCents: input.amountCents,
      approver: decision.value.approver
    })

    return {
      status: "approved" as const,
      approver: decision.value.approver,
      entryId: entry.entryId
    }
  }
})
