import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const Channel = t.union([
  t.literal("email"),
  t.literal("in-app"),
  t.literal("webhook")
])

const rolloutChannels: Array<typeof Channel.Type> = ["email", "in-app", "webhook"]

const Audience = t.struct({
  name: t.string,
  recipients: t.number
})

const RolloutRejected = t.taggedStruct("RolloutRejected", {
  reason: t.string
})

const EmptyAudience = t.taggedStruct("EmptyAudience", {
  audience: t.string
})

const reserveLaunchSlot = defineStep({
  name: "ReserveLaunchSlot",
  input: t.struct({ campaignId: t.string }),
  output: t.struct({ holdId: t.string }),
  execute: async (input) => {
    console.log(`[slot] reserved for ${input.campaignId}`)
    return { holdId: `hold-${input.campaignId}` }
  },
  compensate: async (result) => {
    console.log(`[slot] released ${result.holdId}`)
  }
})

const prepareChannel = defineStep({
  name: "PrepareChannel",
  input: t.struct({ campaignId: t.string, channel: Channel }),
  output: t.struct({ channel: Channel, assetId: t.string }),
  retry: { attempts: 2, backoff: "exponential" },
  concurrency: { limit: 2, key: (input) => input.campaignId },
  execute: async (input, step) => {
    if (input.channel === "webhook" && step.attempt === 1) {
      throw new Error("local webhook renderer is warming up")
    }
    console.log(`[channel] ${input.channel} ready for ${input.campaignId}`)
    return { channel: input.channel, assetId: `${input.campaignId}-${input.channel}` }
  }
})

const scheduleAudience = defineStep({
  name: "ScheduleAudience",
  input: t.struct({ campaignId: t.string, audience: Audience, launchCode: t.string }),
  output: t.struct({ audience: t.string, recipients: t.number }),
  errors: EmptyAudience,
  execute: async (input, step) => {
    if (input.audience.name === "empty") {
      return step.fail({ _tag: "EmptyAudience", audience: input.audience.name })
    }
    console.log(`[audience] ${input.audience.name} scheduled with ${input.launchCode}`)
    return { audience: input.audience.name, recipients: input.audience.recipients }
  },
  compensate: async (result) => {
    console.log(`[audience] unscheduled ${result.audience}`)
  }
})

const announceLaunch = defineStep({
  name: "AnnounceLaunch",
  input: t.struct({ campaignId: t.string, launchCode: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(`[launch] ${input.campaignId} is live (${input.launchCode})`)
  }
})

export const CampaignRolloutWorkflow = defineWorkflow({
  name: "CampaignRolloutWorkflow",
  input: t.struct({
    campaignId: t.string,
    audiences: t.array(Audience),
    requireApproval: t.optional(t.boolean)
  }),
  output: t.struct({
    launchCode: t.string,
    scheduledAudiences: t.array(t.string),
    channels: t.array(Channel)
  }),
  errors: t.union([RolloutRejected, EmptyAudience]),
  run: function* (input, ctx) {
    const plan = yield* ctx.code("build-rollout-plan", {
      reason: "Snapshot the input into a stable release plan before side effects begin",
      output: t.struct({ audiences: t.array(Audience), channels: t.array(Channel) }),
      run: () => ({
        audiences: input.audiences,
        channels: rolloutChannels
      })
    })

    const [slot, email, inApp, webhook] = yield* ctx.all([
      ctx.run(reserveLaunchSlot, { campaignId: input.campaignId }),
      ctx.run(prepareChannel, { campaignId: input.campaignId, channel: "email" }),
      ctx.run(prepareChannel, { campaignId: input.campaignId, channel: "in-app" }),
      ctx.run(prepareChannel, { campaignId: input.campaignId, channel: "webhook" })
    ], { name: "provision-rollout", concurrency: 2 })

    const plannedAt = yield* ctx.now()
    const random = yield* ctx.random()
    const launchCode = yield* ctx.code("make-launch-code", {
      reason: "Derive a repeatable code from recorded time and randomness",
      output: t.string,
      run: () => `${input.campaignId}-${plannedAt.getUTCFullYear()}-${Math.floor(random * 10_000)}`
    })

    const scheduledAudiences: Array<typeof t.string.Type> = []
    for (const audience of plan.audiences) {
      const scheduled = yield* ctx.run(scheduleAudience, {
        campaignId: input.campaignId,
        audience,
        launchCode
      })
      scheduledAudiences.push(scheduled.audience)
    }

    yield* ctx.sleep("1 second", "review-window")
    if (input.requireApproval ?? true) {
      const approval = yield* ctx.waitForSignal(
        "rolloutApproval",
        t.struct({ approved: t.boolean, reviewer: t.string }),
        { timeout: "1 minute" }
      )
      if (approval.type === "timeout" || !approval.value.approved) {
        return yield* ctx.fail({ _tag: "RolloutRejected", reason: "rollout was not approved" })
      }
    }

    yield* ctx.run(announceLaunch, { campaignId: input.campaignId, launchCode })
    console.log(`[slot] confirmed ${slot.holdId}; assets: ${email.assetId}, ${inApp.assetId}, ${webhook.assetId}`)

    return { launchCode, scheduledAudiences, channels: plan.channels }
  }
})
