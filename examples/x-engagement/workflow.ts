import { defineStep, defineWorkflow, secret, t } from "wf"
import {
  draftReply as draftReplyAdapter,
  fetchTimeline as fetchTimelineAdapter,
  postReply as postReplyAdapter,
  selectCandidates as selectCandidatesAdapter
} from "./adapters"

const TimelinePost = t.struct({
  id: t.string,
  author: t.string,
  text: t.string,
  createdAt: t.string
})

const RankedCandidate = t.struct({
  post: TimelinePost,
  reason: t.string
})

const PostedReply = t.struct({
  postId: t.string,
  replyText: t.string
})

const SkippedPost = t.struct({
  postId: t.string,
  reason: t.string
})

const Decision = t.union([
  t.taggedStruct("accept", {}),
  t.taggedStruct("edit", { text: t.string }),
  t.taggedStruct("feedback", { note: t.string }),
  t.taggedStruct("decline", {})
])

const DuplicateReplyRejected = t.taggedStruct("DuplicateReplyRejected", {
  postId: t.string
})

export const fetchTimeline = defineStep({
  name: "fetchTimeline",
  input: t.struct({ bearerToken: t.string }),
  output: t.array(TimelinePost),
  retry: { attempts: 3, backoff: "exponential" },
  execute: async (input) => fetchTimelineAdapter(input)
})

export const selectCandidates = defineStep({
  name: "selectCandidates",
  input: t.struct({
    posts: t.array(TimelinePost),
    maxCandidates: t.number,
    apiKey: t.string,
    model: t.optional(t.string)
  }),
  output: t.array(RankedCandidate),
  execute: async (input) => selectCandidatesAdapter(input)
})

export const draftReply = defineStep({
  name: "draftReply",
  input: t.struct({
    post: TimelinePost,
    feedback: t.array(t.string),
    apiKey: t.string,
    model: t.optional(t.string)
  }),
  output: t.string,
  execute: async (input) => draftReplyAdapter(input)
})

export const notifyReviewer = defineStep({
  name: "notifyReviewer",
  input: t.struct({
    executionId: t.string,
    signalName: t.string,
    post: TimelinePost,
    reason: t.string,
    draft: t.string
  }),
  output: t.void,
  execute: async (input) => {
    console.log("")
    console.log(`Review reply for ${input.post.author} (${input.post.id})`)
    console.log(`Reason: ${input.reason}`)
    console.log(`Post: ${input.post.text}`)
    console.log(`Draft: ${input.draft}`)
    console.log("Respond with one of:")
    console.log(`  bun run examples/x-engagement/review.ts ${input.executionId} accept`)
    console.log(`  bun run examples/x-engagement/review.ts ${input.executionId} decline`)
    console.log(`  bun run examples/x-engagement/review.ts ${input.executionId} edit "replacement text"`)
    console.log(`  bun run examples/x-engagement/review.ts ${input.executionId} feedback "what to change"`)
    console.log(`Signal name: ${input.signalName}`)
  }
})

export const postReply = defineStep({
  name: "postReply",
  input: t.struct({
    bearerToken: t.string,
    postId: t.string,
    replyText: t.string,
    dryRun: t.boolean
  }),
  output: t.struct({ posted: t.boolean }),
  errors: DuplicateReplyRejected,
  retry: { attempts: 3, backoff: "exponential" },
  concurrency: { limit: 1 },
  execute: async (input, step) => {
    try {
      return await postReplyAdapter(input)
    } catch (error) {
      if (typeof error === "object" && error !== null && "duplicateReply" in error) {
        return step.fail({ _tag: "DuplicateReplyRejected", postId: input.postId })
      }
      throw error
    }
  }
})

export const XEngagementWorkflow = defineWorkflow({
  name: "XEngagementWorkflow",
  version: 1,
  input: t.struct({
    maxCandidates: t.optional(t.number),
    maxRevisions: t.optional(t.number),
    dryRun: t.optional(t.boolean)
  }),
  output: t.struct({
    considered: t.number,
    posted: t.array(PostedReply),
    skipped: t.array(SkippedPost)
  }),
  errors: DuplicateReplyRejected,
  run: function* (input, ctx) {
    const maxCandidates = input.maxCandidates ?? 2
    const maxRevisions = input.maxRevisions ?? 3
    const dryRun = input.dryRun ?? true

    const timeline = yield* ctx.run(fetchTimeline, {
      bearerToken: secret("x-bearer-token")
    })
    const candidates = yield* ctx.run(selectCandidates, {
      posts: timeline,
      maxCandidates,
      apiKey: secret("opencode-zen-api-key"),
      model: "minimax-m2.5-free"
    })

    const posted: Array<typeof PostedReply.Type> = []
    const skipped: Array<typeof SkippedPost.Type> = []

    for (const candidate of candidates) {
      const feedback: string[] = []
      let decided = false

      for (let revision = 0; revision <= maxRevisions && !decided; revision++) {
        const draft = yield* ctx.run(draftReply, {
          post: candidate.post,
          feedback,
          apiKey: secret("opencode-zen-api-key"),
          model: "minimax-m2.5-free"
        })
        const signalName = `reviewDecision:${candidate.post.id}`
        yield* ctx.run(notifyReviewer, {
          executionId: ctx.executionId,
          signalName,
          post: candidate.post,
          reason: candidate.reason,
          draft
        })

        const decision = yield* ctx.waitForSignal(signalName, Decision, { timeout: "24 hours" })
        if (decision.type === "timeout") {
          skipped.push({ postId: candidate.post.id, reason: "review-timeout" })
          decided = true
          continue
        }

        switch (decision.value._tag) {
          case "accept":
            yield* ctx.run(postReply, {
              bearerToken: secret("x-bearer-token"),
              postId: candidate.post.id,
              replyText: draft,
              dryRun
            })
            posted.push({ postId: candidate.post.id, replyText: draft })
            decided = true
            break
          case "edit":
            yield* ctx.run(postReply, {
              bearerToken: secret("x-bearer-token"),
              postId: candidate.post.id,
              replyText: decision.value.text,
              dryRun
            })
            posted.push({ postId: candidate.post.id, replyText: decision.value.text })
            decided = true
            break
          case "feedback":
            feedback.push(decision.value.note)
            if (feedback.length > maxRevisions) {
              skipped.push({ postId: candidate.post.id, reason: "max-revisions" })
              decided = true
            }
            break
          case "decline":
            skipped.push({ postId: candidate.post.id, reason: "review-declined" })
            decided = true
            break
        }
      }
    }

    return {
      considered: timeline.length,
      posted,
      skipped
    }
  }
})
