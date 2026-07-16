import { afterEach, describe, expect, test } from "bun:test"
import { createTestRuntime } from "@mokronos/wfkit"
import { configureXEngagementAdapters, resetXEngagementAdapters } from "./adapters"
import { XEngagementWorkflow } from "./workflow"

const secretValues = {
  zen: "test-zen-secret",
  x: "test-x-secret"
}

const startRuntime = () => {
  const rt = createTestRuntime()
  rt.setSecret("opencode-zen-api-key", secretValues.zen)
  rt.setSecret("x-bearer-token", secretValues.x)
  return rt
}

const serveZen = (handler: (messages: ReadonlyArray<{ role: string; content: string }>) => string) => {
  const requests: Array<ReadonlyArray<{ role: string; content: string }>> = []
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      readonly messages: ReadonlyArray<{ role: string; content: string }>
    }
      requests.push(body.messages)
      return Response.json({
        choices: [{ message: { content: handler(body.messages) } }]
      })
  }
  configureXEngagementAdapters({ zenBaseUrl: "http://zen.test/v1", fetch: fetchStub })
  return { requests }
}

afterEach(() => {
  resetXEngagementAdapters()
})

describe("XEngagementWorkflow", () => {
  test("accept path posts the drafted reply", async () => {
    serveZen((messages) =>
      messages[0]?.content.includes("Rank X timeline posts")
        ? JSON.stringify([{ postId: "193950001001", reason: "durable HITL observation" }])
        : "What made timeout-as-value click for you?"
    )
    const rt = startRuntime()
    const exec = await rt.start(XEngagementWorkflow, { maxCandidates: 1 })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001001", { _tag: "accept" })

    await expect(rt.result(exec.executionId)).resolves.toEqual({
      type: "completed",
      value: {
        considered: 8,
        posted: [{ postId: "193950001001", replyText: "What made timeout-as-value click for you?" }],
        skipped: []
      }
    })
  })

  test("edit path posts the reviewer text verbatim", async () => {
    serveZen((messages) =>
      messages[0]?.content.includes("Rank X timeline posts")
        ? JSON.stringify([{ postId: "193950001003", reason: "acceptance-test point" }])
        : "Original draft"
    )
    const rt = startRuntime()
    const exec = await rt.start(XEngagementWorkflow, { maxCandidates: 1 })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001003", {
      _tag: "edit",
      text: "Edited by reviewer."
    })

    await expect(rt.result(exec.executionId)).resolves.toMatchObject({
      type: "completed",
      value: {
        posted: [{ postId: "193950001003", replyText: "Edited by reviewer." }],
        skipped: []
      }
    })
  })

  test("feedback loops into a revised draft before accept", async () => {
    let draftCount = 0
    const { requests } = serveZen((messages) => {
      if (messages[0]?.content.includes("Rank X timeline posts")) {
        return JSON.stringify([{ postId: "193950001006", reason: "asks teams for practical signal" }])
      }
      draftCount++
      return draftCount === 1 ? "First draft" : "Revised draft"
    })
    const rt = startRuntime()
    const exec = await rt.start(XEngagementWorkflow, { maxCandidates: 1, maxRevisions: 2 })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001006", {
      _tag: "feedback",
      note: "ask for one concrete incident example"
    })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001006", { _tag: "accept" })

    await expect(rt.result(exec.executionId)).resolves.toMatchObject({
      type: "completed",
      value: {
        posted: [{ postId: "193950001006", replyText: "Revised draft" }],
        skipped: []
      }
    })
    expect(JSON.stringify(requests)).toContain("ask for one concrete incident example")
  })

  test("decline and timeout skip candidates", async () => {
    serveZen((messages) =>
      messages[0]?.content.includes("Rank X timeline posts")
        ? JSON.stringify([
          { postId: "193950001001", reason: "first" },
          { postId: "193950001003", reason: "second" }
        ])
        : "Draft"
    )
    const rt = startRuntime()
    const exec = await rt.start(XEngagementWorkflow, { maxCandidates: 2 })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001001", { _tag: "decline" })

    await expect(rt.result(exec.executionId)).resolves.toMatchObject({
      type: "completed",
      value: {
        posted: [],
        skipped: [
          { postId: "193950001001", reason: "review-declined" },
          { postId: "193950001003", reason: "review-timeout" }
        ]
      }
    })
  })

  test("secret values are absent from serialized history", async () => {
    serveZen((messages) =>
      messages[0]?.content.includes("Rank X timeline posts")
        ? JSON.stringify([{ postId: "193950001001", reason: "secret scan" }])
        : "Secret-safe draft"
    )
    const rt = startRuntime()
    const exec = await rt.start(XEngagementWorkflow, { maxCandidates: 1 })
    await rt.sendSignal(exec.executionId, "reviewDecision:193950001001", { _tag: "accept" })
    await rt.result(exec.executionId)

    const serialized = JSON.stringify(await rt.history(exec.executionId))
    expect(serialized).toContain("secret:opencode-zen-api-key")
    expect(serialized).toContain("secret:x-bearer-token")
    expect(serialized).not.toContain(secretValues.zen)
    expect(serialized).not.toContain(secretValues.x)
  })
})
