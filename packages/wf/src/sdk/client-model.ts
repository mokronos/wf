import type { DefinedWorkflow } from "../core.ts"
import type { JsonSchema, WorkflowHistoryEvent, WorkflowHistoryRecord, WorkflowPayload, WorkflowRunStatus } from "../schemas.ts"

export type WorkflowExecutionStatus = WorkflowRunStatus

export interface WorkflowExecutionHandle {
  readonly executionId: string
}

export type WorkflowResult =
  | { readonly type: "completed"; readonly value: unknown }
  | { readonly type: "failed"; readonly error: unknown }

export type WorkflowObservation =
  | { readonly type: "terminal"; readonly result: WorkflowResult }
  | { readonly type: "signal-suspended"; readonly pendingSignals: ReadonlyArray<PendingSignal> }

export type { WorkflowHistoryEvent, WorkflowHistoryRecord }

export interface WorkflowExecutionRecord {
  readonly executionId: string
  readonly artifactId?: string
  readonly workflowName: string
  readonly status: WorkflowExecutionStatus
  readonly payload: WorkflowPayload
  readonly startedAt: string
  readonly finishedAt?: string
  /** Snapshot of the workflow source this execution started against. */
  readonly sourceHash?: string
}

export interface PendingSignal {
  readonly name: string
  readonly invocation: number
  readonly activityName: string
  readonly timeout?: unknown
  /** JSON Schema of the payload the wait expects. */
  readonly payloadSchema?: JsonSchema
}

export interface WorkflowListResult {
  readonly executions: ReadonlyArray<{
    readonly executionId: string
    readonly workflowName: string
    readonly status: WorkflowExecutionStatus
    readonly startedAt: string
    readonly finishedAt?: string
  }>
  readonly cursor?: string
}

export interface WorkflowClient {
  start<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    payload: I,
    opts?: {
      readonly idempotencyKey?: string
      readonly actor?: string
      readonly artifactId?: string
      readonly sourceHash?: string
    }
  ): Promise<WorkflowExecutionHandle>
  signal(
    executionId: string,
    name: string,
    payload: WorkflowPayload,
    opts?: { readonly actor?: string }
  ): Promise<void>
  result(executionId: string): Promise<WorkflowResult>
  status(executionId: string): Promise<WorkflowExecutionStatus>
  execution(executionId: string): Promise<WorkflowExecutionRecord>
  executions(): Promise<ReadonlyArray<WorkflowExecutionRecord>>
  list<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    opts?: {
      readonly status?: WorkflowExecutionStatus
      readonly limit?: number
      readonly cursor?: string
    }
  ): Promise<WorkflowListResult>
  history(executionId: string): Promise<ReadonlyArray<WorkflowHistoryRecord>>
  pendingSignals(executionId: string): Promise<ReadonlyArray<PendingSignal>>
  cancel(
    executionId: string,
    opts?: { readonly compensate?: boolean; readonly actor?: string }
  ): Promise<void>
  /** Waits for a terminal result or signal suspension without exposing polling. */
  observe(executionId: string, options?: { readonly signal?: AbortSignal }): Promise<WorkflowObservation>
  dispose(): Promise<void>
}
