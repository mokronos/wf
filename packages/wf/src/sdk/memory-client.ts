import { Schema } from "effect"
import { Cancelled, createInMemoryDeterminismState } from "../core.ts"
import { isCancellableRunStatus, isTerminalRunStatus, statusAfterEvent } from "../run-lifecycle.ts"
import { ExecutionId } from "../schemas.ts"
import type { WorkflowHistoryEvent, WorkflowHistoryRecord } from "../schemas.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import { createSignalTransport } from "../signal.ts"
import {
  createSignalDeliveryClaims,
  nowIso,
  observeExecution,
  optionalActor,
  optionalCursor,
  optionalFinishedAt,
  paginate,
  pendingSignalsFromHistory
} from "./client-lifecycle.ts"
import type {
  WorkflowClient,
  WorkflowExecutionRecord,
  WorkflowExecutionStatus,
  WorkflowResult
} from "./client-model.ts"

interface ExecutionRecord {
  readonly executionId: string
  readonly artifactId?: string
  readonly sourceHash?: string
  readonly workflowName: string
  readonly payload: unknown
  status: WorkflowExecutionStatus
  result?: WorkflowResult
  readonly startedAt: string
  finishedAt?: string
  readonly history: WorkflowHistoryRecord[]
  readonly abort: AbortController
  cancellation?: Cancelled
  readonly resultPromise: Promise<WorkflowResult>
  readonly resolveResult: (result: WorkflowResult) => void
}

const memoryExecutionRecord = (execution: ExecutionRecord): WorkflowExecutionRecord => ({
  executionId: execution.executionId,
  ...(execution.artifactId === undefined ? {} : { artifactId: execution.artifactId }),
  workflowName: execution.workflowName,
  status: execution.status,
  payload: execution.payload,
  startedAt: execution.startedAt,
  ...optionalFinishedAt(execution.finishedAt),
  ...(execution.sourceHash === undefined ? {} : { sourceHash: execution.sourceHash })
})

export const createMemoryWorkflowClient = (runtime?: WorkflowRuntime): WorkflowClient => {
  const executions = new Map<string, ExecutionRecord>()
  const idempotencyKeys = new Map<string, string>()
  const signals = runtime?.signals ?? createSignalTransport()
  const signalClaims = createSignalDeliveryClaims()
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const ensureActive = (): void => {
    if (disposed) {
      throw new Error("Workflow client has been disposed")
    }
  }

  const appendHistory = (record: ExecutionRecord, event: WorkflowHistoryEvent) => {
    record.history.push({
      sequence: record.history.length + 1,
      createdAt: nowIso(),
      event
    })
  }

  const requireExecution = (id: string): ExecutionRecord => {
    const execution = executions.get(id)
    if (execution === undefined) throw new Error(`Unknown workflow execution: ${id}`)
    return execution
  }

  return {
    async start(workflow, payload, opts = {}) {
      ensureActive()
      Schema.decodeUnknownSync(workflow.input)(payload)
      const workflowKey = workflow.name
      if (opts.idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(`${workflowKey}:${opts.idempotencyKey}`)
        if (existingId !== undefined) return { executionId: existingId }
      }

      const id = crypto.randomUUID()
      let resolveResult!: (result: WorkflowResult) => void
      const resultPromise = new Promise<WorkflowResult>((resolve) => {
        resolveResult = resolve
      })
      const execution: ExecutionRecord = {
        executionId: id,
        ...(opts.artifactId === undefined ? {} : { artifactId: opts.artifactId }),
        ...(opts.sourceHash === undefined ? {} : { sourceHash: opts.sourceHash }),
        workflowName: workflow.name,
        payload,
        status: "running",
        startedAt: nowIso(),
        history: [],
        abort: new AbortController(),
        resultPromise,
        resolveResult
      }
      executions.set(id, execution)
      if (opts.idempotencyKey !== undefined) {
        idempotencyKeys.set(`${workflowKey}:${opts.idempotencyKey}`, id)
      }

      appendHistory(execution, {
        type: "execution.started",
        executionId: ExecutionId.make(id),
        workflowName: workflow.name,
        payload,
        ...optionalActor(opts.actor)
      })

      void workflow.executeInMemory(payload, {
        executionId: id,
        signal: execution.abort.signal,
        determinism: createInMemoryDeterminismState(),
        signalTransport: signals,
        ...(runtime?.secrets === undefined ? {} : { secrets: runtime.secrets }),
        ...(runtime?.integrations === undefined ? {} : { integrations: runtime.integrations }),
        ...(runtime?.concurrency === undefined ? {} : { concurrency: runtime.concurrency }),
        onEvent: async (event) => {
          appendHistory(execution, event)
          const nextStatus = statusAfterEvent(event)
          if (nextStatus !== undefined && execution.status !== "failed") {
            execution.status = nextStatus
          }
          if (event.type === "sleep.started") {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
        }
      }).then(
        (value) => {
          execution.status = "completed"
          execution.finishedAt = nowIso()
          execution.result = { type: "completed", value }
          execution.resolveResult(execution.result)
          signals.cleanup(id)
        },
        (error) => {
          execution.status = "failed"
          execution.finishedAt = nowIso()
          execution.result = { type: "failed", error: execution.cancellation ?? error }
          execution.resolveResult(execution.result)
          signals.cleanup(id, error)
        }
      )
      return { executionId: id }
    },

    async signal(id, name, payload, opts = {}) {
      const execution = requireExecution(id)
      const waiting = pendingSignalsFromHistory(execution.history)
        .filter((signal) => signal.name === name)
        .at(-1)
      if (waiting === undefined) {
        throw new Error(`Execution ${id} is not waiting for signal ${name}`)
      }
      signalClaims.claim(id, waiting)
      try {
        await signals.deliver(id, name, payload)
      } catch (error) {
        signalClaims.release(id, waiting)
        throw error
      }
      appendHistory(execution, {
        type: "signal.delivered",
        executionId: ExecutionId.make(id),
        name,
        payload,
        ...optionalActor(opts.actor)
      })
    },

    result: (id) => requireExecution(id).resultPromise,
    status: async (id) => requireExecution(id).status,
    execution: async (id) => memoryExecutionRecord(requireExecution(id)),
    executions: async () => Array.from(executions.values())
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(memoryExecutionRecord),

    async list(workflow, opts = {}) {
      const all = Array.from(executions.values())
        .filter((execution) => execution.workflowName === workflow.name)
        .filter((execution) => opts.status === undefined || execution.status === opts.status)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      const page = paginate(all, opts)
      return {
        executions: page.items.map((execution) => ({
          executionId: execution.executionId,
          workflowName: execution.workflowName,
          status: execution.status,
          startedAt: execution.startedAt,
          ...optionalFinishedAt(execution.finishedAt)
        })),
        ...optionalCursor(page.cursor)
      }
    },

    history: async (id) => requireExecution(id).history,
    pendingSignals: async (id) => pendingSignalsFromHistory(requireExecution(id).history),

    async cancel(id, opts = {}) {
      const execution = requireExecution(id)
      if (!isCancellableRunStatus(execution.status)) {
        throw new Error(`Cannot cancel ${execution.status} execution ${id}`)
      }
      const compensate = opts.compensate ?? true
      const cancellation = new Cancelled({ compensate })
      execution.cancellation = cancellation
      appendHistory(execution, {
        type: "execution.cancelled",
        executionId: ExecutionId.make(id),
        compensate,
        ...optionalActor(opts.actor)
      })
      if (compensate) execution.status = "compensating"
      signals.cancel(id, cancellation)
      if (!compensate) execution.abort.abort(cancellation)
      const result = await execution.resultPromise
      if (result.type === "failed") execution.status = "failed"
    },

    observe: (id, options = {}) => observeExecution({
      status: async (executionId) => requireExecution(executionId).status,
      result: (executionId) => requireExecution(executionId).resultPromise,
      pendingSignals: async (executionId) =>
        pendingSignalsFromHistory(requireExecution(executionId).history)
    }, id, options.signal),

    async dispose() {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      disposePromise = (async () => {
        for (const execution of executions.values()) {
          if (!isTerminalRunStatus(execution.status)) {
            const error = new Error("Workflow client has been disposed")
            signals.cleanup(execution.executionId, error)
            execution.abort.abort(error)
          }
        }
        await runtime?.dispose()
        executions.clear()
        idempotencyKeys.clear()
        signalClaims.clear()
      })()
      await disposePromise
    }
  }
}
