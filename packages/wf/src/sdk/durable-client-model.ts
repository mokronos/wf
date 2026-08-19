import { whenPresent } from "../optional.ts"
import type { WorkflowPayload } from "../schemas.ts"
import { Schema } from "effect"
import {
  WorkflowHistoryEvent,
  WorkflowRunStatus
} from "../schemas.ts"
import { optionalFinishedAt } from "./client-lifecycle.ts"
import type { WorkflowExecutionRecord } from "./client-model.ts"

// JSON omits properties with an `undefined` value. An optional envelope field
// preserves that value for `Schema.Void` workflow inputs and outputs.
const StoredValueJson = Schema.fromJsonString(
  Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })
)

export const encodeStoredValue = (value: WorkflowPayload): string =>
  Schema.encodeSync(StoredValueJson)({ value })

/** Two steps on purpose: the envelope says whether a value was stored at all,
 *  then the value itself is parsed. Anything in there survived JSON.stringify,
 *  so JSON-or-absent is the whole of what it can be. */
export const decodeStoredValue = (json: string): WorkflowPayload =>
  Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.Json))(
    Schema.decodeUnknownSync(StoredValueJson)(json).value
  )

export const DurableExecutionRow = Schema.Struct({
  id: Schema.String,
  artifact_id: Schema.NullOr(Schema.String),
  workflow_name: Schema.String,
  status: WorkflowRunStatus,
  payload_json: Schema.String,
  idempotency_key: Schema.NullOr(Schema.String),
  actor: Schema.NullOr(Schema.String),
  source_hash: Schema.NullOr(Schema.String),
  result_json: Schema.NullOr(Schema.String),
  error_json: Schema.NullOr(Schema.String),
  started_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String)
})
export type DurableExecutionRow = typeof DurableExecutionRow.Type

export const DurableHistoryRow = Schema.Struct({
  sequence: Schema.Number,
  event_json: Schema.String,
  created_at: Schema.String
})
export type DurableHistoryRow = typeof DurableHistoryRow.Type

const StoredHistoryEventJson = Schema.fromJsonString(WorkflowHistoryEvent)

export const decodeExecutionRow = Schema.decodeUnknownSync(DurableExecutionRow)
export const decodeHistoryRow = Schema.decodeUnknownSync(DurableHistoryRow)
export const decodeStoredHistoryEvent = Schema.decodeUnknownSync(StoredHistoryEventJson)

export const durableExecutionRecord = (
  row: DurableExecutionRow
): WorkflowExecutionRecord => ({
  executionId: row.id,
  ...whenPresent("artifactId", row.artifact_id),
  workflowName: row.workflow_name,
  status: row.status,
  payload: decodeStoredValue(row.payload_json),
  startedAt: row.started_at,
  ...optionalFinishedAt(row.finished_at ?? undefined),
  ...whenPresent("sourceHash", row.source_hash)
})
