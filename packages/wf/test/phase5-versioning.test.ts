import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import {
  createSqliteWorkflowRepository,
  createWorkflowClient,
  createWorkflowRuntime,
  defineWorkflow,
  MissingWorkflowVersionError,
  WorkflowVersionConflictError
} from "../src"

const dbPath = () => path.join(mkdtempSync(path.join(tmpdir(), "wf-phase5-")), "wf.sqlite")

const waitForStatus = async (
  client: ReturnType<typeof createWorkflowClient>,
  executionId: string,
  expected: string
) => {
  for (let index = 0; index < 100; index++) {
    const status = await client.status(executionId)
    if (status === expected) {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return client.status(executionId)
}

const waitForHistoryEvent = async (
  client: ReturnType<typeof createWorkflowClient>,
  executionId: string,
  type: string
) => {
  for (let index = 0; index < 100; index++) {
    const history = await client.history(executionId)
    if (history.some((record) => record.event.type === type)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for history event ${type}`)
}

describe("Phase 5 workflow versioning", () => {
  test("sqlite executions stay pinned to v1 while new starts use latest registered version", async () => {
    const workflowV1 = defineWorkflow({
      name: "versionedApproval",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ ok: Schema.Boolean }))
        return signal.type === "signal" && signal.value.ok ? "v1-approved" : "v1-rejected"
      }
    })
    const workflowV2 = defineWorkflow({
      name: "versionedApproval",
      version: 2,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* () {
        return "v2-new-start"
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([workflowV1])
    const client = createWorkflowClient(runtime)

    const v1Handle = await client.start(workflowV1, {})
    expect(v1Handle.version).toBe(1)
    expect(await waitForStatus(client, v1Handle.executionId, "suspended")).toBe("suspended")
    await waitForHistoryEvent(client, v1Handle.executionId, "signal.waiting")

    runtime.register([workflowV1, workflowV2])
    const v2Handle = await client.start(workflowV1, {})
    expect(v2Handle.version).toBe(2)
    await expect(client.result(v2Handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "v2-new-start"
    })

    await client.signal(v1Handle.executionId, "approval", { ok: true })
    await expect(client.result(v1Handle.executionId)).resolves.toEqual({
      type: "completed",
      value: "v1-approved"
    })

    const v1Executions = await client.list(workflowV1, { version: 1 })
    expect(v1Executions.executions.map((execution) => execution.executionId)).toEqual([
      v1Handle.executionId
    ])
    const v2Executions = await client.list(workflowV1, { version: 2 })
    expect(v2Executions.executions.map((execution) => execution.executionId)).toEqual([
      v2Handle.executionId
    ])
  })

  test("resuming a pinned version that is not registered fails with a named operator error", async () => {
    const workflowV1 = defineWorkflow({
      name: "missingPinnedVersion",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* (_, ctx) {
        const signal = yield* ctx.waitForSignal("approval", Schema.Struct({ ok: Schema.Boolean }))
        return signal.type === "signal" && signal.value.ok ? "v1" : "rejected"
      }
    })
    const workflowV2 = defineWorkflow({
      name: "missingPinnedVersion",
      version: 2,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* () {
        return "v2"
      }
    })
    const databasePath = dbPath()
    const runtime1 = createWorkflowRuntime({ backend: "sqlite", databasePath })
    runtime1.register([workflowV1])
    const client1 = createWorkflowClient(runtime1)
    const handle = await client1.start(workflowV1, {})
    expect(await waitForStatus(client1, handle.executionId, "suspended")).toBe("suspended")
    await waitForHistoryEvent(client1, handle.executionId, "signal.waiting")

    const runtime2 = createWorkflowRuntime({ backend: "sqlite", databasePath })
    runtime2.register([workflowV2])
    const client2 = createWorkflowClient(runtime2)

    await expect(client2.result(handle.executionId)).rejects.toBeInstanceOf(MissingWorkflowVersionError)
    await expect(client2.signal(handle.executionId, "approval", { ok: true })).rejects.toBeInstanceOf(
      MissingWorkflowVersionError
    )
  })

  test("registering the same workflow version with different source is rejected", async () => {
    const first = defineWorkflow({
      name: "conflictingVersion",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* () {
        return "first"
      }
    })
    const second = defineWorkflow({
      name: "conflictingVersion",
      version: 1,
      input: Schema.Struct({}),
      output: Schema.String,
      run: function* () {
        return "second"
      }
    })
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: dbPath() })
    runtime.register([first])

    expect(() => runtime.register([second])).toThrow(WorkflowVersionConflictError)
  })

  test("sqlite workflow repository catalogs by name and version without overwriting source", async () => {
    const repository = createSqliteWorkflowRepository({ databasePath: dbPath() })
    await repository.upsertWorkflow({
      id: "legacy-id-v1",
      name: "cataloged",
      version: "1",
      source: "export const workflow = 'v1'",
      createdAt: "2026-01-01T00:00:00.000Z"
    })
    await repository.upsertWorkflow({
      id: "legacy-id-v2",
      name: "cataloged",
      version: "2",
      source: "export const workflow = 'v2'",
      createdAt: "2026-01-01T00:00:00.000Z"
    })

    await expect(repository.upsertWorkflow({
      id: "another-id-v1",
      name: "cataloged",
      version: "1",
      source: "export const workflow = 'changed'",
      createdAt: "2026-01-01T00:00:00.000Z"
    })).rejects.toThrow("already cataloged with different source")

    await expect(repository.list()).resolves.toHaveLength(2)
  })
})
