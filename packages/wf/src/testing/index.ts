import type * as Duration from "effect/Duration"
import type {
  DefinedWorkflow,
  InMemoryDeterminismState,
  Step,
  StepContext,
  TerminalFailure
} from "../core.ts"
import { createInMemoryDeterminismState } from "../core.ts"
import type {
  WorkflowExecutionHandle,
  WorkflowExecutionStatus,
  WorkflowHistoryEvent,
  WorkflowHistoryRecord,
  WorkflowResult
} from "../sdk/index.ts"
import { Cancelled } from "../sdk/index.ts"
import { cancelSignalWaits, deliverSignal } from "../signal.ts"
import { ExecutionId } from "../schemas.ts"

export interface TestRuntimeOptions {
  readonly timeSkipping?: boolean
}

export interface CompensationRecorder {
  readonly calls: Array<{ readonly step: string; readonly result: unknown }>
}

export interface TestRuntime {
  mockStep<I, O, E>(
    step: Step<I, O, E>,
    impl: (input: I, step: StepContext<E>) => Promise<O | TerminalFailure<E>>
  ): void
  failStepOnce<I, O, E>(step: Step<I, O, E>): void
  recordCompensations(): CompensationRecorder
  start<I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    payload: I,
    opts?: { readonly idempotencyKey?: string; readonly actor?: string }
  ): Promise<WorkflowExecutionHandle>
  replay<I, O, E>(
    executionId: string,
    workflow: DefinedWorkflow<I, O, E>,
    payload: I
  ): Promise<WorkflowExecutionHandle>
  sendSignal(executionId: string, name: string, payload: unknown): Promise<void>
  result(executionId: string): Promise<WorkflowResult>
  status(executionId: string): Promise<WorkflowExecutionStatus>
  history(executionId: string): Promise<ReadonlyArray<WorkflowHistoryRecord>>
  cancel(executionId: string, opts?: { readonly compensate?: boolean; readonly actor?: string }): Promise<void>
  advanceTime(duration: Duration.Input): Promise<void>
  /** Register a secret value so SecretRef inputs resolve inside step execute. */
  setSecret(name: string, value: string): void
}

interface ExecutionRecord {
  readonly executionId: string
  readonly workflow: DefinedWorkflow
  readonly payload: unknown
  readonly determinism: InMemoryDeterminismState
  status: WorkflowExecutionStatus
  result?: WorkflowResult
  readonly startedAt: string
  finishedAt?: string
  readonly history: WorkflowHistoryRecord[]
  readonly resultPromise: Promise<WorkflowResult>
  readonly resolveResult: (result: WorkflowResult) => void
}

interface VirtualTimer {
  readonly due: number
  readonly resolve: () => void
}

const nowIso = () => new Date().toISOString()
const executionId = () => crypto.randomUUID()

const parseDurationMs = (duration: Duration.Input): number => {
  if (typeof duration === "number") {
    return duration
  }
  const raw = String(duration).trim()
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(raw)
  if (match === null) {
    return 0
  }
  const value = Number(match[1])
  const unit = (match[2] ?? "millis").toLowerCase()
  if (unit.startsWith("ms") || unit.startsWith("milli")) return value
  if (unit.startsWith("sec")) return value * 1_000
  if (unit.startsWith("min")) return value * 60_000
  if (unit.startsWith("hour")) return value * 60 * 60_000
  if (unit.startsWith("day")) return value * 24 * 60 * 60_000
  return value
}

const statusFromEvent = (event: WorkflowHistoryEvent): WorkflowExecutionStatus | undefined => {
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

export const createTestRuntime = (options: TestRuntimeOptions = {}): TestRuntime => {
  const timeSkipping = options.timeSkipping ?? true
  const executions = new Map<string, ExecutionRecord>()
  const idempotencyKeys = new Map<string, string>()
  const stepMocks = new Map<Step<any, any, any>, Step<any, any, any>["execute"]>()
  const failOnce = new Set<Step<any, any, any>>()
  const recorders: CompensationRecorder[] = []
  const timers: VirtualTimer[] = []
  const secrets = new Map<string, string>()
  let virtualNow = 0

  const secretResolver = {
    resolve: (name: string) => {
      const value = secrets.get(name)
      if (value === undefined) {
        throw new Error(`Unknown test secret: ${name} (register it with rt.setSecret)`)
      }
      return value
    }
  }

  const appendHistory = (record: ExecutionRecord, event: WorkflowHistoryEvent) => {
    record.history.push({
      sequence: record.history.length + 1,
      createdAt: nowIso(),
      event
    })
    const nextStatus = statusFromEvent(event)
    if (nextStatus !== undefined && record.status !== "failed") {
      record.status = nextStatus
    }
    if (event.type === "compensation.started") {
      for (const recorder of recorders) {
        recorder.calls.push({ step: event.stepName, result: event.result })
      }
    }
  }

  const requireExecution = (id: string): ExecutionRecord => {
    const execution = executions.get(id)
    if (execution === undefined) {
      throw new Error(`Unknown workflow execution: ${id}`)
    }
    return execution
  }

  const makeDelay = (duration: Duration.Input): Promise<void> => {
    if (timeSkipping) {
      return new Promise((resolve) => setTimeout(resolve, 0))
    }
    const due = virtualNow + parseDurationMs(duration)
    return new Promise((resolve) => {
      timers.push({ due, resolve })
    })
  }

  const buildStepExecutors = () => {
    const executors = new Map<Step<any, any, any>, Step<any, any, any>["execute"]>()
    const steps = new Set([...stepMocks.keys(), ...failOnce])
    for (const step of steps) {
      executors.set(step, async (input: unknown, context: StepContext<unknown>) => {
        if (failOnce.has(step)) {
          failOnce.delete(step)
          throw new Error(`Injected failure for step ${step.name}`)
        }
        const mock = stepMocks.get(step)
        return mock === undefined
          ? step.execute(input, context as never)
          : mock(input, context as never)
      })
    }
    return executors
  }

  const launch = (
    workflow: DefinedWorkflow,
    payload: unknown,
    record: ExecutionRecord
  ) => {
    void workflow.executeInMemory(payload as never, {
      executionId: record.executionId,
      determinism: record.determinism,
      stepExecutors: buildStepExecutors(),
      sleep: ({ duration }) => makeDelay(duration),
      signalTimeout: ({ duration }) => makeDelay(duration),
      secrets: secretResolver,
      onEvent: (event) => {
        appendHistory(record, event as WorkflowHistoryEvent)
      }
    }).then(
      (value) => {
        record.status = "completed"
        record.finishedAt = nowIso()
        record.result = { type: "completed", value }
        record.resolveResult(record.result)
      },
      (error) => {
        record.status = "failed"
        record.finishedAt = nowIso()
        record.result = { type: "failed", error }
        record.resolveResult(record.result)
      }
    )
  }

  const createExecution = (
    workflow: DefinedWorkflow,
    payload: unknown,
    opts: { readonly id?: string; readonly determinism?: InMemoryDeterminismState; readonly actor?: string } = {}
  ): ExecutionRecord => {
    let resolveResult!: (result: WorkflowResult) => void
    const resultPromise = new Promise<WorkflowResult>((resolve) => {
      resolveResult = resolve
    })
    const id = opts.id ?? executionId()
    const record: ExecutionRecord = {
      executionId: id,
      workflow,
      payload,
      determinism: opts.determinism ?? createInMemoryDeterminismState(),
      status: "running",
      startedAt: nowIso(),
      history: [],
      resultPromise,
      resolveResult
    }
    executions.set(id, record)
    appendHistory(record, {
      type: "execution.started",
      executionId: ExecutionId.make(id),
      workflowName: workflow.name,
      version: workflow.version,
      payload,
      ...(opts.actor === undefined ? {} : { actor: opts.actor })
    })
    launch(workflow, payload, record)
    return record
  }

  return {
    mockStep(step, impl) {
      stepMocks.set(step, impl as Step<any, any, any>["execute"])
    },

    failStepOnce(step) {
      failOnce.add(step as Step<any, any, any>)
    },

    recordCompensations() {
      const recorder: CompensationRecorder = { calls: [] }
      recorders.push(recorder)
      return recorder
    },

    async start(workflow, payload, opts = {}) {
      const workflowKey = `${workflow.name}@v${workflow.version}`
      if (opts.idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(`${workflowKey}:${opts.idempotencyKey}`)
        if (existingId !== undefined) {
          return { executionId: existingId, version: workflow.version }
        }
      }
      const record = createExecution(workflow, payload, opts.actor === undefined ? {} : { actor: opts.actor })
      if (opts.idempotencyKey !== undefined) {
        idempotencyKeys.set(`${workflowKey}:${opts.idempotencyKey}`, record.executionId)
      }
      return { executionId: record.executionId, version: workflow.version }
    },

    async replay(id, workflow, payload) {
      const previous = requireExecution(id)
      const record = createExecution(workflow, payload, {
        id,
        determinism: previous.determinism
      })
      return { executionId: record.executionId, version: workflow.version }
    },

    sendSignal(executionId, name, payload) {
      return deliverSignal(executionId, name, payload)
    },

    result(executionId) {
      return requireExecution(executionId).resultPromise
    },

    async status(executionId) {
      return requireExecution(executionId).status
    },

    async history(executionId) {
      return requireExecution(executionId).history
    },

    async cancel(executionId, opts = {}) {
      const record = requireExecution(executionId)
      const compensate = opts.compensate ?? true
      appendHistory(record, {
        type: "execution.cancelled",
        executionId: ExecutionId.make(executionId),
        compensate,
        ...(opts.actor === undefined ? {} : { actor: opts.actor })
      })
      if (compensate) {
        record.status = "compensating"
      }
      cancelSignalWaits(executionId, new Cancelled({ compensate }))
    },

    setSecret(name, value) {
      secrets.set(name, value)
    },

    async advanceTime(duration) {
      virtualNow += parseDurationMs(duration)
      timers.sort((left, right) => left.due - right.due)
      for (let index = 0; index < timers.length;) {
        const timer = timers[index]!
        if (timer.due > virtualNow) {
          index++
          continue
        }
        timers.splice(index, 1)
        timer.resolve()
      }
      await Promise.resolve()
    }
  }
}
