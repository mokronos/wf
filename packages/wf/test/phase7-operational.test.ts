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
  envSecretResolver,
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
  test("envSecretResolver resolves default and explicit environment mappings", async () => {
    const originalDefault = process.env["X_BEARER_TOKEN"]
    const originalMapped = process.env["CUSTOM_STRIPE_KEY"]
    try {
      process.env["X_BEARER_TOKEN"] = "x-token"
      process.env["CUSTOM_STRIPE_KEY"] = "stripe-token"

      await expect(Promise.resolve(envSecretResolver().resolve("x-bearer-token"))).resolves.toBe("x-token")
      await expect(Promise.resolve(envSecretResolver({
        mapping: { "stripe-key": "CUSTOM_STRIPE_KEY" }
      }).resolve("stripe-key"))).resolves.toBe("stripe-token")
    } finally {
      if (originalDefault === undefined) {
        delete process.env["X_BEARER_TOKEN"]
      } else {
        process.env["X_BEARER_TOKEN"] = originalDefault
      }
      if (originalMapped === undefined) {
        delete process.env["CUSTOM_STRIPE_KEY"]
      } else {
        process.env["CUSTOM_STRIPE_KEY"] = originalMapped
      }
    }
  })

  test("envSecretResolver supports fallback and clear missing-secret errors", async () => {
    const original = process.env["MISSING_SECRET"]
    try {
      delete process.env["MISSING_SECRET"]
      await expect(Promise.resolve(envSecretResolver({ fallback: "" }).resolve("missing-secret"))).resolves.toBe("")
      await expect(Promise.resolve().then(() => envSecretResolver().resolve("missing-secret"))).rejects.toThrow(
        'Secret "missing-secret" not found: set env var MISSING_SECRET'
      )
    } finally {
      if (original === undefined) {
        delete process.env["MISSING_SECRET"]
      } else {
        process.env["MISSING_SECRET"] = original
      }
    }
  })

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

  test("signal-delivery resume resolves secrets in the delivering runtime", async () => {
    const seenByExecute: string[] = []
    const callApi = defineStep({
      name: "callApiAfterSignal",
      input: Schema.Struct({ apiKey: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: async (input) => {
        seenByExecute.push(input.apiKey)
        return { ok: true }
      }
    })
    const workflow = defineWorkflow({
      name: "secretAfterSignal",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.Boolean,
      run: function* (_input, ctx) {
        const approval = yield* ctx.waitForSignal("go", Schema.Struct({ ok: Schema.Boolean }), {
          timeout: "1 minute"
        })
        if (approval.type === "timeout") {
          return false
        }
        const result = yield* ctx.run(callApi, { apiKey: secret("zen-key") })
        return result.ok
      }
    })

    const databasePath = dbPath()
    // The starter has no secret resolver: this simulates the real repro where
    // the starting process exited before the signal arrives (per-execution
    // resolvers live in an in-process map), so the replay triggered by the
    // second runtime's signal delivery must install its own resolver.
    const starter = createWorkflowRuntime({ backend: "sqlite", databasePath })
    starter.register([workflow])
    const startClient = createWorkflowClient(starter)
    const handle = await startClient.start(workflow, {})
    for (let index = 0; index < 100; index++) {
      const history = await startClient.history(handle.executionId)
      if (history.some((record) => record.event.type === "signal.waiting")) {
        break
      }
      await sleep(10)
    }

    const signaler = createWorkflowRuntime({
      backend: "sqlite",
      databasePath,
      secrets: { resolve: (name) => `resolved-${name}-value` }
    })
    signaler.register([workflow])
    const signalClient = createWorkflowClient(signaler)
    await signalClient.signal(handle.executionId, "go", { ok: true })

    await expect(signalClient.result(handle.executionId)).resolves.toEqual({
      type: "completed",
      value: true
    })
    expect(seenByExecute).toEqual(["resolved-zen-key-value"])
  })
})
