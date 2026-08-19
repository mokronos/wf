import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import type { WorkflowHistoryEvent, WorkflowHistoryRecord } from "../schemas.ts"
import { replayDedupeKey } from "../replay.ts"
import { nowIso } from "./client-lifecycle.ts"
import { migrateClientDatabase } from "./client-database.ts"
import {
  decodeExecutionRow,
  decodeHistoryRow,
  decodeStoredHistoryEvent,
  encodeStoredValue
} from "./durable-client-model.ts"
import type {
  DurableExecutionRow,
  DurableHistoryRow
} from "./durable-client-model.ts"
import { toJsonText } from "./json.ts"

const NewExecution = Schema.Struct({
  id: Schema.String,
  artifactId: Schema.optionalKey(Schema.String),
  workflowName: Schema.String,
  payload: Schema.UndefinedOr(Schema.Json),
  idempotencyKey: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Schema.String),
  sourceHash: Schema.optionalKey(Schema.String)
})
type NewExecution = typeof NewExecution.Type

export const createDurableClientStore = (databasePath: string) => {
  mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true })
  const database = new Database(databasePath, { create: true, readwrite: true })
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
  migrateClientDatabase(database)

  const get = (executionId: string): DurableExecutionRow => {
    const row = database.query<DurableExecutionRow, [string]>(`
      SELECT *
      FROM wf_client_executions
      WHERE id = ?
    `).get(executionId)
    if (row === null) {
      throw new Error(`Unknown workflow execution: ${executionId}`)
    }
    return decodeExecutionRow(row)
  }

  const history = (executionId: string): ReadonlyArray<WorkflowHistoryRecord> => {
    get(executionId)
    return database.query<DurableHistoryRow, [string]>(`
      SELECT sequence, event_json, created_at
      FROM wf_client_history
      WHERE execution_id = ?
      ORDER BY sequence
    `).all(executionId).map((row) => decodeHistoryRow(row)).map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at,
      event: decodeStoredHistoryEvent(row.event_json)
    }))
  }

  const withImmediateTransaction = <A>(operation: () => A): A => {
    database.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      database.exec("COMMIT")
      return result
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  const appendHistoryRecord = (
    executionId: string,
    event: WorkflowHistoryEvent
  ): boolean => {
    const dedupeKey = replayDedupeKey(event) ?? null
    if (dedupeKey !== null) {
      const existing = database.query<{ id: number }, [string, string]>(`
        SELECT id
        FROM wf_client_history
        WHERE execution_id = ? AND dedupe_key = ?
      `).get(executionId, dedupeKey)
      if (existing !== null) return false
    }
    const sequence = database.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM wf_client_history
      WHERE execution_id = ?
    `).get(executionId)?.sequence ?? 1
    database.query<Record<string, never>, [string, number, string, string, string | null]>(`
      INSERT INTO wf_client_history (execution_id, sequence, event_json, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?)
    `).run(executionId, sequence, toJsonText(event), nowIso(), dedupeKey)
    return true
  }

  return {
    get,

    all: (): ReadonlyArray<DurableExecutionRow> =>
      database.query<DurableExecutionRow, []>(`
        SELECT *
        FROM wf_client_executions
        ORDER BY started_at DESC
      `).all().map((row) => decodeExecutionRow(row)),

    forWorkflow: (workflowName: string): ReadonlyArray<DurableExecutionRow> =>
      database.query<DurableExecutionRow, [string]>(`
        SELECT *
        FROM wf_client_executions
        WHERE workflow_name = ?
        ORDER BY started_at
      `).all(workflowName).map((row) => decodeExecutionRow(row)),

    findIdempotent: (workflowName: string, idempotencyKey: string): string | undefined =>
      database.query<{ id: string }, [string, string]>(`
        SELECT id
        FROM wf_client_executions
        WHERE workflow_name = ?
          AND idempotency_key = ?
      `).get(workflowName, idempotencyKey)?.id,

    insert: (input: NewExecution): boolean => {
      const value = Schema.decodeUnknownSync(NewExecution)(input)
      const result = database.query<
        Record<string, never>,
        [string, string | null, string, string, string | null, string | null, string | null, string]
      >(`
        INSERT INTO wf_client_executions (
          id, artifact_id, workflow_name, status, payload_json,
          idempotency_key, actor, source_hash, started_at
        )
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)
        ON CONFLICT(workflow_name, idempotency_key)
          WHERE idempotency_key IS NOT NULL
          DO NOTHING
      `).run(
        value.id,
        value.artifactId ?? null,
        value.workflowName,
        encodeStoredValue(value.payload),
        value.idempotencyKey ?? null,
        value.actor ?? null,
        value.sourceHash ?? null,
        nowIso()
      )
      return result.changes === 1
    },

    appendHistory: (executionId: string, event: WorkflowHistoryEvent): boolean =>
      withImmediateTransaction(() => appendHistoryRecord(executionId, event)),

    claimCancellation: (
      executionId: string,
      event: WorkflowHistoryEvent,
      error: Schema.Schema.Type<typeof Schema.Unknown>,
      compensate: boolean
    ): boolean => withImmediateTransaction(() => {
      const result = compensate
        ? database.query<Record<string, never>, [string]>(`
            UPDATE wf_client_executions
            SET status = 'compensating'
            WHERE id = ? AND status IN ('running', 'suspended')
          `).run(executionId)
        : database.query<Record<string, never>, [string, string, string]>(`
            UPDATE wf_client_executions
            SET status = 'failed', error_json = ?, finished_at = ?
            WHERE id = ? AND status IN ('running', 'suspended')
          `).run(toJsonText(error), nowIso(), executionId)
      if (result.changes !== 1) return false
      appendHistoryRecord(executionId, event)
      return true
    }),

    updateStatus: (executionId: string, status: DurableExecutionRow["status"]): boolean => {
      const result = database.query<Record<string, never>, [DurableExecutionRow["status"], string]>(`
        UPDATE wf_client_executions
        SET status = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'compensating')
      `).run(status, executionId)
      return result.changes === 1
    },

    complete: (executionId: string, value: Schema.Schema.Type<typeof Schema.Unknown>): boolean => {
      const result = database.query<Record<string, never>, [string, string, string]>(`
        UPDATE wf_client_executions
        SET status = 'completed', result_json = ?, finished_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed', 'compensating')
      `).run(toJsonText(value), nowIso(), executionId)
      return result.changes === 1
    },

    fail: (executionId: string, error: Schema.Schema.Type<typeof Schema.Unknown>): boolean => {
      const result = database.query<Record<string, never>, [string, string, string]>(`
        UPDATE wf_client_executions
        SET status = 'failed', error_json = ?, finished_at = ?
        WHERE id = ? AND status NOT IN ('completed', 'failed')
      `).run(toJsonText(error), nowIso(), executionId)
      return result.changes === 1
    },

    history,
    close: (): void => database.close()
  }
}

export type DurableClientStore = ReturnType<typeof createDurableClientStore>
