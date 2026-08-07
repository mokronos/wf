import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWorkflowClient, createWorkflowRuntime, defineStep, defineWorkflow, t } from "../src"

const databasePath = () =>
  path.join(mkdtempSync(path.join(tmpdir(), "wf-client-migration-")), "engine.sqlite")

/**
 * The shape written before workflow versioning was removed: a NOT NULL
 * workflow_version nothing fills any more, an idempotency index keyed on it, and
 * the per-name source pin that made editing a workflow an error.
 */
const seedLegacyClientDatabase = (file: string) => {
  const database = new Database(file, { create: true, readwrite: true })
  database.exec(`
    CREATE TABLE wf_client_executions (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      actor TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX wf_client_executions_idempotency_idx
      ON wf_client_executions(workflow_name, workflow_version, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE wf_client_workflows (
      workflow_name TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      PRIMARY KEY (workflow_name)
    );

    CREATE TABLE wf_client_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(execution_id, sequence)
    );
  `)
  database.query(`
    INSERT INTO wf_client_executions (
      id, workflow_name, workflow_version, status, payload_json, started_at, finished_at
    )
    VALUES ('old-run', 'Greet', '1', 'completed', '{"value":{}}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')
  `).run()
  database.query(`
    INSERT INTO wf_client_workflows (workflow_name, workflow_version, source_hash, registered_at)
    VALUES ('Greet', '1', 'a-hash-from-before', '2026-01-01T00:00:00.000Z')
  `).run()
  database.close()
}

const greet = defineStep({
  name: "Greet",
  input: t.struct({ name: t.string }),
  output: t.string,
  execute: async (input) => `hello ${input.name}`
})

const greetWorkflow = defineWorkflow({
  name: "Greet",
  input: t.struct({ name: t.string }),
  output: t.string,
  run: function* (input, ctx) {
    return yield* ctx.run(greet, { name: input.name })
  }
})

describe("durable client database migration", () => {
  test("starts runs against a database written before versioning was removed", async () => {
    const file = databasePath()
    seedLegacyClientDatabase(file)

    const client = createWorkflowClient(
      createWorkflowRuntime({ backend: "sqlite", databasePath: file })
    )
    try {
      const handle = await client.start(greetWorkflow, { name: "world" }, { sourceHash: "a".repeat(64) })
      expect(await client.result(handle.executionId)).toEqual({ type: "completed", value: "hello world" })

      // Existing runs are still readable, and the new run records its pin.
      expect((await client.executions()).map((execution) => execution.executionId)).toContain("old-run")
      expect((await client.execution("old-run")).sourceHash).toBe("a-hash-from-before")
      expect((await client.execution(handle.executionId)).sourceHash).toBe("a".repeat(64))
    } finally {
      await client.dispose()
    }
  }, 15_000)

  test("no longer refuses a workflow whose source changed since an earlier run", async () => {
    const file = databasePath()
    seedLegacyClientDatabase(file)

    const client = createWorkflowClient(
      createWorkflowRuntime({ backend: "sqlite", databasePath: file })
    )
    try {
      // 'Greet' was pinned to a different source hash by the legacy table.
      const handle = await client.start(greetWorkflow, { name: "again" })
      expect(await client.result(handle.executionId)).toEqual({ type: "completed", value: "hello again" })
    } finally {
      await client.dispose()
    }
  }, 15_000)
})
