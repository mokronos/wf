import { Database } from "bun:sqlite"
import type { DefinedWorkflow } from "../core"
import { Cancelled, cancellationDeferredName, createInMemoryDeterminismState } from "../core"
import type { WorkflowEvent } from "../events"
import { createWorkflowRuntime, executeWorkflow } from "../runtime"
import type { ExecuteWorkflowOptions } from "../runtime"
import type { WorkflowRuntime } from "../runtime"
import { cancelSignalWaits, deliverSignal } from "../signal"
import type {
  WorkflowArtifact,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStore
} from "./artifact"
import { createFileWorkflowStore } from "./artifact"
import { parseJsonText, toJsonText } from "./json"
import { loadWorkflowArtifact } from "./loader"

export type WorkflowExecutionStatus =
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "compensating"

export interface WorkflowExecutionHandle {
  readonly executionId: string
  readonly version: number
}

export type WorkflowResult =
  | { readonly type: "completed"; readonly value: unknown }
  | { readonly type: "failed"; readonly error: unknown }

export type WorkflowHistoryEvent =
  | WorkflowEvent
  | {
      readonly type: "execution.started"
      readonly executionId: string
      readonly workflowName: string
      readonly version: number
      readonly payload: unknown
      readonly actor?: string
    }
  | {
      readonly type: "signal.delivered"
      readonly executionId: string
      readonly name: string
      readonly payload: unknown
      readonly actor?: string
    }
  | {
      readonly type: "execution.cancelled"
      readonly executionId: string
      readonly compensate: boolean
      readonly actor?: string
    }

export interface WorkflowHistoryRecord {
  readonly sequence: number
  readonly createdAt: string
  readonly event: WorkflowHistoryEvent
}

export interface PendingSignal {
  readonly name: string
  readonly invocation: number
  readonly activityName: string
  readonly timeout?: unknown
}

export interface WorkflowListResult {
  readonly executions: ReadonlyArray<{
    readonly executionId: string
    readonly workflowName: string
    readonly version: number
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
    opts?: { readonly idempotencyKey?: string; readonly actor?: string; readonly version?: number }
  ): Promise<WorkflowExecutionHandle>
  signal(
    executionId: string,
    name: string,
    payload: unknown,
    opts?: { readonly actor?: string }
  ): Promise<void>
  result(executionId: string): Promise<WorkflowResult>
  status(executionId: string): Promise<WorkflowExecutionStatus>
  list<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    opts?: {
      readonly status?: WorkflowExecutionStatus
      readonly version?: number
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
}

export { Cancelled } from "../core"

export class MissingWorkflowVersionError extends Error {
  readonly _tag = "MissingWorkflowVersionError"
  readonly workflowName: string
  readonly version: number

  constructor(options: { readonly workflowName: string; readonly version: number }) {
    super(
      `Workflow ${options.workflowName}@v${options.version} is not registered in this runtime; re-register that exact version before resuming this execution`
    )
    this.name = "MissingWorkflowVersionError"
    this.workflowName = options.workflowName
    this.version = options.version
  }
}

interface ExecutionRecord {
  readonly executionId: string
  readonly workflow: DefinedWorkflow<any, any, any>
  readonly payload: unknown
  status: WorkflowExecutionStatus
  result?: WorkflowResult
  readonly startedAt: string
  finishedAt?: string
  readonly history: WorkflowHistoryRecord[]
  readonly resultPromise: Promise<WorkflowResult>
  readonly resolveResult: (result: WorkflowResult) => void
}

const executionId = () => crypto.randomUUID()
const nowIso = () => new Date().toISOString()
const encodeStoredValue = (value: unknown): string => JSON.stringify({ value })
const decodeStoredValue = (json: string): unknown => (JSON.parse(json) as { value: unknown }).value
const optionalActor = (actor: string | undefined): { readonly actor?: string } =>
  actor === undefined ? {} : { actor }
const optionalFinishedAt = (finishedAt: string | undefined): { readonly finishedAt?: string } =>
  finishedAt === undefined ? {} : { finishedAt }
const optionalCursor = (cursor: string | undefined): { readonly cursor?: string } =>
  cursor === undefined ? {} : { cursor }
const signalKey = (event: { readonly name: string; readonly invocation: number }) =>
  `${event.name}:${event.invocation}`
const optionalTimeout = (timeout: unknown): { readonly timeout?: unknown } =>
  timeout === undefined ? {} : { timeout }

export const pendingSignalsFromHistory = (
  history: ReadonlyArray<WorkflowHistoryRecord>
): ReadonlyArray<PendingSignal> => {
  const consumed = new Set<string>()
  for (const record of history) {
    const event = record.event
    if (event.type === "signal.received" || event.type === "signal.timeout") {
      consumed.add(signalKey(event))
    }
  }

  return history.flatMap((record) => {
    const event = record.event
    if (event.type !== "signal.waiting" || consumed.has(signalKey(event))) {
      return []
    }
    return [{
      name: event.name,
      invocation: event.invocation,
      activityName: event.activityName,
      ...optionalTimeout(event.timeout)
    }]
  })
}

export const createWorkflowClient = (
  runtime: WorkflowRuntime = createWorkflowRuntime({ backend: "memory" })
): WorkflowClient =>
  runtime.backend === "sqlite" ? createDurableWorkflowClient(runtime) : createMemoryWorkflowClient(runtime)

const createMemoryWorkflowClient = (runtime?: WorkflowRuntime): WorkflowClient => {
  const executions = new Map<string, ExecutionRecord>()
  const idempotencyKeys = new Map<string, string>()

  const appendHistory = (record: ExecutionRecord, event: WorkflowHistoryEvent) => {
    record.history.push({
      sequence: record.history.length + 1,
      createdAt: nowIso(),
      event
    })
  }

  const requireExecution = (id: string): ExecutionRecord => {
    const execution = executions.get(id)
    if (execution === undefined) {
      throw new Error(`Unknown workflow execution: ${id}`)
    }
    return execution
  }

  const statusFromEvent = (event: WorkflowEvent): WorkflowExecutionStatus | undefined => {
    switch (event.type) {
      case "sleep.started":
      case "signal.waiting":
        return "suspended"
      case "sleep.completed":
      case "signal.received":
      case "signal.timeout":
      case "step.started":
      case "step.completed":
        return "running"
      default:
        return undefined
    }
  }

  return {
    async start(workflow, payload, opts = {}) {
      const workflowKey = `${workflow.name}@v${workflow.version}`
      if (opts.idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(`${workflowKey}:${opts.idempotencyKey}`)
        if (existingId !== undefined) {
          return { executionId: existingId, version: workflow.version }
        }
      }

      const id = executionId()
      let resolveResult!: (result: WorkflowResult) => void
      const resultPromise = new Promise<WorkflowResult>((resolve) => {
        resolveResult = resolve
      })
      const execution: ExecutionRecord = {
        executionId: id,
        workflow,
        payload,
        status: "running",
        startedAt: nowIso(),
        history: [],
        resultPromise,
        resolveResult
      }
      executions.set(id, execution)
      if (opts.idempotencyKey !== undefined) {
        idempotencyKeys.set(`${workflowKey}:${opts.idempotencyKey}`, id)
      }

      appendHistory(execution, {
        type: "execution.started",
        executionId: id,
        workflowName: workflow.name,
        version: workflow.version,
        payload,
        ...optionalActor(opts.actor)
      })

      void workflow
        .executeInMemory(payload, {
          executionId: id,
          determinism: createInMemoryDeterminismState(),
          ...(runtime?.secrets === undefined ? {} : { secrets: runtime.secrets }),
          onEvent: async (event) => {
            appendHistory(execution, event as WorkflowEvent)
            const nextStatus = statusFromEvent(event as WorkflowEvent)
            if (nextStatus !== undefined && execution.status !== "failed") {
              execution.status = nextStatus
            }
            if ((event as WorkflowEvent).type === "sleep.started") {
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
          }
        })
        .then(
          (value) => {
            execution.status = "completed"
            execution.finishedAt = nowIso()
            execution.result = { type: "completed", value }
            execution.resolveResult(execution.result)
          },
          (error) => {
            execution.status = "failed"
            execution.finishedAt = nowIso()
            execution.result = { type: "failed", error }
            execution.resolveResult(execution.result)
          }
        )

      return { executionId: id, version: workflow.version }
    },

    async signal(id, name, payload, opts = {}) {
      const execution = requireExecution(id)
      await deliverSignal(id, name, payload)
      appendHistory(execution, {
        type: "signal.delivered",
        executionId: id,
        name,
        payload,
        ...optionalActor(opts.actor)
      })
    },

    result(id) {
      return requireExecution(id).resultPromise
    },

    async status(id) {
      return requireExecution(id).status
    },

    async list(workflow, opts = {}) {
      const all = Array.from(executions.values())
        .filter((execution) => execution.workflow.name === workflow.name)
        .filter((execution) => opts.version === undefined || execution.workflow.version === opts.version)
        .filter((execution) => opts.status === undefined || execution.status === opts.status)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      const start = opts.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10)
      const limit = opts.limit ?? all.length
      const page = all.slice(start, start + limit)
      const next = start + limit < all.length ? String(start + limit) : undefined
      return {
        executions: page.map((execution) => ({
          executionId: execution.executionId,
          workflowName: execution.workflow.name,
          version: execution.workflow.version,
          status: execution.status,
          startedAt: execution.startedAt,
          ...optionalFinishedAt(execution.finishedAt)
        })),
        ...optionalCursor(next)
      }
    },

    async history(id) {
      return requireExecution(id).history
    },

    async pendingSignals(id) {
      return pendingSignalsFromHistory(requireExecution(id).history)
    },

    async cancel(id, opts = {}) {
      const execution = requireExecution(id)
      const compensate = opts.compensate ?? true
      appendHistory(execution, {
        type: "execution.cancelled",
        executionId: id,
        compensate,
        ...optionalActor(opts.actor)
      })
      if (compensate) {
        execution.status = "compensating"
      }
      cancelSignalWaits(id, new Cancelled({ compensate }))
      const result = await execution.resultPromise
      if (result.type === "failed") {
        execution.status = "failed"
      }
    }
  }
}

interface DurableExecutionRow {
  readonly id: string
  readonly workflow_name: string
  readonly workflow_version: number
  readonly status: WorkflowExecutionStatus
  readonly payload_json: string
  readonly idempotency_key: string | null
  readonly actor: string | null
  readonly result_json: string | null
  readonly error_json: string | null
  readonly started_at: string
  readonly finished_at: string | null
}

interface DurableWorkflowCatalogRow {
  readonly workflow_name: string
  readonly workflow_version: number
  readonly source_hash: string
  readonly registered_at: string
}

interface DurableHistoryRow {
  readonly sequence: number
  readonly event_json: string
  readonly created_at: string
}

const migrateClientDb = (db: Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wf_client_executions (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      idempotency_key TEXT,
      actor TEXT,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS wf_client_executions_idempotency_idx
      ON wf_client_executions(workflow_name, workflow_version, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS wf_client_workflows (
      workflow_name TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      PRIMARY KEY (workflow_name, workflow_version)
    );

    CREATE TABLE IF NOT EXISTS wf_client_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(execution_id, sequence)
    );
  `)
}

const createDurableWorkflowClient = (runtime: WorkflowRuntime): WorkflowClient => {
  const databasePath = runtime.databasePath
  if (databasePath === undefined) {
    throw new Error("SQLite workflow client requires runtime.databasePath")
  }
  const db = new Database(databasePath, { create: true, readwrite: true })
  migrateClientDb(db)
  const runPromises = new Map<string, Promise<WorkflowResult>>()

  const registerCatalog = (workflow: DefinedWorkflow) => {
    const existing = db.query<DurableWorkflowCatalogRow, [string, number]>(`
      SELECT workflow_name, workflow_version, source_hash, registered_at
      FROM wf_client_workflows
      WHERE workflow_name = ?
        AND workflow_version = ?
    `).get(workflow.name, workflow.version)

    if (existing !== null) {
      if (existing.source_hash !== workflow.sourceHash) {
        throw new Error(
          `Workflow ${workflow.name}@v${workflow.version} is already cataloged with different source; register a new version instead`
        )
      }
      return
    }

    db.query<unknown, [string, number, string, string]>(`
      INSERT INTO wf_client_workflows (workflow_name, workflow_version, source_hash, registered_at)
      VALUES (?, ?, ?, ?)
    `).run(workflow.name, workflow.version, workflow.sourceHash, nowIso())
  }

  const registerCatalogFromRuntime = (name: string) => {
    for (const workflow of runtime.listWorkflows(name)) {
      registerCatalog(workflow)
    }
  }

  const appendHistory = (executionId: string, event: WorkflowHistoryEvent) => {
    const sequence = db.query<{ sequence: number }, [string]>(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM wf_client_history
      WHERE execution_id = ?
    `).get(executionId)?.sequence ?? 1
    db.query<unknown, [string, number, string, string]>(`
      INSERT INTO wf_client_history (execution_id, sequence, event_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(executionId, sequence, toJsonText(event), nowIso())
  }

  const updateStatus = (executionId: string, status: WorkflowExecutionStatus) => {
    db.query<unknown, [WorkflowExecutionStatus, string]>(`
      UPDATE wf_client_executions
      SET status = ?
      WHERE id = ?
    `).run(status, executionId)
  }

  const getRow = (executionId: string): DurableExecutionRow => {
    const row = db.query<DurableExecutionRow, [string]>(`
      SELECT *
      FROM wf_client_executions
      WHERE id = ?
    `).get(executionId)
    if (row === null) {
      throw new Error(`Unknown workflow execution: ${executionId}`)
    }
    return row
  }

  const workflowFor = (row: DurableExecutionRow): DefinedWorkflow => {
    const workflow = runtime.getWorkflow(row.workflow_name, row.workflow_version)
    if (workflow === undefined) {
      throw new MissingWorkflowVersionError({
        workflowName: row.workflow_name,
        version: row.workflow_version
      })
    }
    return workflow
  }

  const workflowForStart = (workflow: DefinedWorkflow, version?: number): DefinedWorkflow => {
    runtime.register([workflow])
    registerCatalogFromRuntime(workflow.name)

    const selected = version === undefined
      ? runtime.getLatestWorkflow(workflow.name)
      : runtime.getWorkflow(workflow.name, version)

    if (selected === undefined) {
      throw new MissingWorkflowVersionError({
        workflowName: workflow.name,
        version: version ?? workflow.version
      })
    }

    registerCatalog(selected)
    return selected
  }

  const statusFromEvent = (event: WorkflowEvent): WorkflowExecutionStatus | undefined => {
    switch (event.type) {
      case "sleep.started":
      case "signal.waiting":
        return "suspended"
      case "sleep.completed":
      case "signal.received":
      case "signal.timeout":
      case "step.started":
      case "step.completed":
        return "running"
      default:
        return undefined
    }
  }

  const makeEventSink = (executionId: string) => async (event: WorkflowEvent) => {
    appendHistory(executionId, event)
    const status = statusFromEvent(event)
    if (status !== undefined) {
      updateStatus(executionId, status)
    }
  }

  const readHistory = (executionId: string): ReadonlyArray<WorkflowHistoryRecord> => {
    getRow(executionId)
    return db.query<DurableHistoryRow, [string]>(`
      SELECT sequence, event_json, created_at
      FROM wf_client_history
      WHERE execution_id = ?
      ORDER BY sequence
    `).all(executionId).map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at,
      event: JSON.parse(row.event_json) as WorkflowHistoryEvent
    }))
  }

  const runToTerminal = async (row: DurableExecutionRow): Promise<WorkflowResult> => {
    if (row.status === "completed") {
      return { type: "completed", value: parseJsonText(row.result_json) }
    }
    if (row.status === "failed") {
      return { type: "failed", error: parseJsonText(row.error_json) }
    }

    const existing = runPromises.get(row.id)
    if (existing !== undefined) {
      return existing
    }

    const promise: Promise<WorkflowResult> = (async (): Promise<WorkflowResult> => {
      const workflow = workflowFor(row)
      try {
        const value = await runtime.execute({
          workflow,
          payload: decodeStoredValue(row.payload_json),
          executionId: row.id,
          onEvent: makeEventSink(row.id)
        })
        db.query<unknown, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'completed',
            result_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(value), nowIso(), row.id)
        return { type: "completed", value }
      } catch (error) {
        db.query<unknown, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'failed',
            error_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(error), nowIso(), row.id)
        return { type: "failed", error }
      }
    })()
    runPromises.set(row.id, promise)
    try {
      return await promise
    } finally {
      if (runPromises.get(row.id) === promise) {
        runPromises.delete(row.id)
      }
    }
  }

  return {
    async start(workflow, payload, opts = {}) {
      const selectedWorkflow = workflowForStart(workflow, opts.version)
      if (opts.idempotencyKey !== undefined) {
        const existing = db.query<{ id: string }, [string, number, string]>(`
          SELECT id
          FROM wf_client_executions
          WHERE workflow_name = ?
            AND workflow_version = ?
            AND idempotency_key = ?
        `).get(selectedWorkflow.name, selectedWorkflow.version, opts.idempotencyKey)
        if (existing !== null) {
          return { executionId: existing.id, version: selectedWorkflow.version }
        }
      }

      const id = executionId()
      db.query<unknown, [string, string, number, string, string | null, string | null, string]>(`
        INSERT INTO wf_client_executions (
          id,
          workflow_name,
          workflow_version,
          status,
          payload_json,
          idempotency_key,
          actor,
          started_at
        )
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).run(
        id,
        selectedWorkflow.name,
        selectedWorkflow.version,
        encodeStoredValue(payload),
        opts.idempotencyKey ?? null,
        opts.actor ?? null,
        nowIso()
      )
      appendHistory(id, {
        type: "execution.started",
        executionId: id,
        workflowName: selectedWorkflow.name,
        version: selectedWorkflow.version,
        payload,
        ...optionalActor(opts.actor)
      })

      void runToTerminal(getRow(id))
      return { executionId: id, version: selectedWorkflow.version }
    },

    async signal(executionId, name, payload, opts = {}) {
      const row = getRow(executionId)
      const workflow = workflowFor(row)
      const waiting = pendingSignalsFromHistory(readHistory(executionId))
        .filter((signal) => signal.name === name)
        .at(-1)
      if (waiting === undefined) {
        throw new Error(`Execution ${executionId} is not waiting for signal ${name}`)
      }
      await runtime.deliverSignal({
        workflow,
        executionId,
        deferredName: `signal:${waiting.activityName}`,
        payload,
        onEvent: makeEventSink(executionId)
      })
      appendHistory(executionId, {
        type: "signal.delivered",
        executionId,
        name,
        payload,
        ...optionalActor(opts.actor)
      })
      updateStatus(executionId, "running")
    },

    result(executionId) {
      return runToTerminal(getRow(executionId))
    },

    async status(executionId) {
      return getRow(executionId).status
    },

    async list(workflow, opts = {}) {
      const rows = db.query<DurableExecutionRow, [string]>(`
        SELECT *
        FROM wf_client_executions
        WHERE workflow_name = ?
        ORDER BY started_at
      `).all(workflow.name)
        .filter((row) => opts.version === undefined || row.workflow_version === opts.version)
        .filter((row) => opts.status === undefined || row.status === opts.status)
      const start = opts.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10)
      const limit = opts.limit ?? rows.length
      const page = rows.slice(start, start + limit)
      const next = start + limit < rows.length ? String(start + limit) : undefined
      return {
        executions: page.map((row) => ({
          executionId: row.id,
          workflowName: row.workflow_name,
          version: row.workflow_version,
          status: row.status,
          startedAt: row.started_at,
          ...optionalFinishedAt(row.finished_at ?? undefined)
        })),
        ...optionalCursor(next)
      }
    },

    async history(executionId) {
      return readHistory(executionId)
    },

    async pendingSignals(executionId) {
      return pendingSignalsFromHistory(readHistory(executionId))
    },

    async cancel(executionId, opts = {}) {
      const row = getRow(executionId)
      const workflow = workflowFor(row)
      const compensate = opts.compensate ?? true
      appendHistory(executionId, {
        type: "execution.cancelled",
        executionId,
        compensate,
        ...optionalActor(opts.actor)
      })
      if (compensate) {
        // Complete the reserved cancellation deferred: the execution wakes at
        // its current suspension point, fails with Cancelled, and unwinds the
        // compensation stack before being recorded as failed.
        updateStatus(executionId, "compensating")
        await runtime.deliverSignal({
          workflow,
          executionId,
          deferredName: cancellationDeferredName,
          payload: { compensate: true, ...(opts.actor === undefined ? {} : { actor: opts.actor }) },
          onEvent: makeEventSink(executionId)
        })
        db.query<unknown, [string, string, string]>(`
          UPDATE wf_client_executions
          SET status = 'failed',
            error_json = ?,
            finished_at = ?
          WHERE id = ?
        `).run(toJsonText(new Cancelled({ compensate: true })), nowIso(), executionId)
      } else {
        // Hard kill: engine-level interrupt, no unwind.
        updateStatus(executionId, "failed")
        await runtime.interrupt({ workflow, executionId })
      }
    }
  }
}

export interface RunWorkflowOptions {
  readonly id: string
  readonly input: unknown
  readonly onEvent?: ExecuteWorkflowOptions["onEvent"]
}

export interface WorkflowRunResult {
  readonly artifact: WorkflowArtifact
  readonly exportName: string
  readonly runId?: string
  readonly result: unknown
}

export interface WorkflowSdk {
  listWorkflows(): Promise<ReadonlyArray<WorkflowArtifact>>
  getWorkflow(id: string): Promise<WorkflowArtifact | undefined>
  listRuns(): Promise<ReadonlyArray<WorkflowRunRecord>>
  listRunEvents(runId: string): Promise<ReadonlyArray<WorkflowRunEventRecord>>
  runWorkflow(options: RunWorkflowOptions): Promise<WorkflowRunResult>
}

export interface WorkflowSdkOptions {
  readonly store?: WorkflowStore
  readonly runStore?: WorkflowRunStore
}

export const createWorkflowSdk = (options: WorkflowSdkOptions = {}): WorkflowSdk => {
  const store = options.store ?? createFileWorkflowStore()
  const runStore = options.runStore

  return {
    listWorkflows() {
      return store.list()
    },

    getWorkflow(id) {
      return store.get(id)
    },

    listRuns() {
      return runStore?.listRuns() ?? Promise.resolve([])
    },

    listRunEvents(runId) {
      return runStore?.listRunEvents(runId) ?? Promise.resolve([])
    },

    async runWorkflow({ id, input, onEvent }) {
      const artifact = await store.get(id)

      if (artifact === undefined) {
        throw new Error(`Unknown workflow id: ${id}`)
      }

      const runId = `${artifact.id}:${artifact.version}:${executionId()}`
      await runStore?.startRun({ id: runId, workflow: artifact, input })

      const loaded = await loadWorkflowArtifact(artifact)

      const onRuntimeEvent: ExecuteWorkflowOptions["onEvent"] = async (event) => {
        await runStore?.appendRunEvent({ runId, type: event.type, event })
        await onEvent?.(event)
      }

      try {
        const result = await executeWorkflow(loaded.workflow, input, { onEvent: onRuntimeEvent })
        await runStore?.completeRun({ runId, result })

        return {
          artifact: loaded.artifact,
          exportName: loaded.exportName,
          runId,
          result
        }
      } catch (error) {
        await runStore?.failRun({ runId, error: serializeError(error) })
        throw error
      }
    }
  }
}

const serializeError = (error: unknown): unknown => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }

  return JSON.parse(toJsonText(error))
}
