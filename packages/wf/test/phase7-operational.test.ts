import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import {
  createWorkflowClient,
  createWorkflowRuntime,
  defineStep,
  defineWorkflow,
  secret
} from "../src"
import { createTestRuntime } from "../src/testing"

const dbPath = () => path.join(mkdtempSync(path.join(tmpdir(), "wf-phase7-")), "wf.sqlite")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("Phase 7 concurrency limits", () => {
  test("limit: 2 step never exceeds 2 in flight across 10 concurrent executions", async () => {
    let live = 0
    let maxLive = 0

    const limitedStep = defineStep({
      name: "limitedStep",
      input: Schema.Struct({ id: Schema.Number }),
      output: Schema.Struct({ id: Schema.Number }),
      concurrency: { limit: 2 },
      execute: async (input) => {
        live++
        maxLive = Math.max(maxLive, live)
        await sleep(20)
        live--
        return { id: input.id }
      }
    })

    const workflow = defineWorkflow({
      name: "concurrencyLimit",
      version: 1,
      input: Schema.Struct({ id: Schema.Number }),
      output: Schema.Number,
      run: function* (input, ctx) {
        const result = yield* ctx.run(limitedStep, { id: input.id })
        return result.id
      }
    })

    const runtime = createWorkflowRuntime({ backend: "memory" })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handles = await Promise.all(
      Array.from({ length: 10 }, (_, id) => client.start(workflow, { id }))
    )
    const results = await Promise.all(handles.map((handle) => client.result(handle.executionId)))

    expect(results.every((result) => result.type === "completed")).toBe(true)
    expect(maxLive).toBeGreaterThan(0)
    expect(maxLive).toBeLessThanOrEqual(2)
  })

  test("concurrency key partitions the limit per input", async () => {
    const livePerKey = new Map<string, number>()
    const maxPerKey = new Map<string, number>()
    let liveTotal = 0
    let maxTotal = 0

    const keyedStep = defineStep({
      name: "keyedStep",
      input: Schema.Struct({ key: Schema.String, id: Schema.Number }),
      output: Schema.Struct({ id: Schema.Number }),
      concurrency: { key: (input) => input.key, limit: 1 },
      execute: async (input) => {
        const live = (livePerKey.get(input.key) ?? 0) + 1
        livePerKey.set(input.key, live)
        maxPerKey.set(input.key, Math.max(maxPerKey.get(input.key) ?? 0, live))
        liveTotal++
        maxTotal = Math.max(maxTotal, liveTotal)
        await sleep(20)
        liveTotal--
        livePerKey.set(input.key, live - 1)
        return { id: input.id }
      }
    })

    const workflow = defineWorkflow({
      name: "concurrencyKeyed",
      version: 1,
      input: Schema.Struct({ key: Schema.String, id: Schema.Number }),
      output: Schema.Number,
      run: function* (input, ctx) {
        const result = yield* ctx.run(keyedStep, { key: input.key, id: input.id })
        return result.id
      }
    })

    const runtime = createWorkflowRuntime({ backend: "memory" })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handles = await Promise.all([
      client.start(workflow, { key: "a", id: 1 }),
      client.start(workflow, { key: "a", id: 2 }),
      client.start(workflow, { key: "a", id: 3 }),
      client.start(workflow, { key: "b", id: 4 }),
      client.start(workflow, { key: "b", id: 5 }),
      client.start(workflow, { key: "b", id: 6 })
    ])
    const results = await Promise.all(handles.map((handle) => client.result(handle.executionId)))

    expect(results.every((result) => result.type === "completed")).toBe(true)
    expect(maxPerKey.get("a")).toBe(1)
    expect(maxPerKey.get("b")).toBe(1)
    // Distinct keys are independent: both partitions ran at the same time.
    expect(maxTotal).toBe(2)
  })
})

describe("Phase 7 secret references", () => {
  const makeSecretFixtures = () => {
    const seenByExecute: string[] = []

    const callApi = defineStep({
      name: "callApi",
      input: Schema.Struct({ apiKey: Schema.String, payload: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: async (input) => {
        seenByExecute.push(input.apiKey)
        return { ok: true }
      }
    })

    const workflow = defineWorkflow({
      name: "secretFlow",
      version: 1,
      input: Schema.Struct({ payload: Schema.String }),
      output: Schema.Boolean,
      run: function* (input, ctx) {
        const result = yield* ctx.run(callApi, {
          apiKey: secret("stripe-key"),
          payload: input.payload
        })
        return result.ok
      }
    })

    return { workflow, seenByExecute }
  }

  test("memory backend: execute sees the value, history only the reference", async () => {
    const { workflow, seenByExecute } = makeSecretFixtures()
    const runtime = createWorkflowRuntime({
      backend: "memory",
      secrets: { resolve: (name) => `resolved-${name}-value` }
    })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { payload: "hello" })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: true
    })

    expect(seenByExecute).toEqual(["resolved-stripe-key-value"])

    const history = await client.history(handle.executionId)
    const serialized = JSON.stringify(history)
    expect(serialized).toContain("secret:stripe-key")
    expect(serialized).not.toContain("resolved-stripe-key-value")
  })

  test("sqlite backend: raw database rows never contain the secret value", async () => {
    const { workflow, seenByExecute } = makeSecretFixtures()
    const databasePath = dbPath()
    const runtime = createWorkflowRuntime({
      backend: "sqlite",
      databasePath,
      secrets: { resolve: (name) => `resolved-${name}-value` }
    })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { payload: "hello" })
    await expect(client.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: true
    })

    expect(seenByExecute).toEqual(["resolved-stripe-key-value"])

    const history = await client.history(handle.executionId)
    const serialized = JSON.stringify(history)
    expect(serialized).toContain("secret:stripe-key")
    expect(serialized).not.toContain("resolved-stripe-key-value")

    // SQLite stores strings verbatim: scanning the raw file catches leaks in
    // any table, including the engine's own activity-result storage. Recent
    // writes live in the WAL sidecar until checkpointed, so scan both.
    const raw = [databasePath, `${databasePath}-wal`]
      .map((file) => {
        try {
          return readFileSync(file).toString("latin1")
        } catch {
          return ""
        }
      })
      .join("")
    expect(raw).toContain("secret:stripe-key")
    expect(raw).not.toContain("resolved-stripe-key-value")
  })

  test("missing resolver fails the step instead of leaking the reference as a value", async () => {
    const { workflow, seenByExecute } = makeSecretFixtures()
    const runtime = createWorkflowRuntime({ backend: "memory" })
    runtime.register([workflow])
    const client = createWorkflowClient(runtime)

    const handle = await client.start(workflow, { payload: "hello" })
    const result = await client.result(handle.executionId)
    expect(result.type).toBe("failed")
    expect(seenByExecute).toEqual([])
  })

  test("test runtime resolves secrets registered with setSecret", async () => {
    const { workflow, seenByExecute } = makeSecretFixtures()
    const rt = createTestRuntime()
    rt.setSecret("stripe-key", "test-secret-value")

    const exec = await rt.start(workflow, { payload: "hello" })
    await expect(rt.result(exec.executionId)).resolves.toEqual({
      type: "completed",
      value: true
    })
    expect(seenByExecute).toEqual(["test-secret-value"])

    const history = await rt.history(exec.executionId)
    const serialized = JSON.stringify(history)
    expect(serialized).toContain("secret:stripe-key")
    expect(serialized).not.toContain("test-secret-value")
  })
})
