import { whenPresent } from "../optional.ts"
import type { WorkflowPayload } from "../schemas.ts"
import * as Duration from "effect/Duration"
import { Schema } from "effect"
import type {
  DefinedWorkflow,
  DefinedStep,
  InMemoryDeterminismState,
  StepContext,
  StepExecutionContext,
  TerminalFailure
} from "../core.ts"
import type { SynchronousSchema } from "../core.ts"
import { createInMemoryDeterminismState, terminalFailure } from "../core.ts"
import type {
  WorkflowExecutionHandle,
  WorkflowExecutionStatus,
  WorkflowHistoryEvent,
  WorkflowHistoryRecord,
  WorkflowResult
} from "../sdk/index.ts"
import { Cancelled } from "../sdk/index.ts"
import { createSignalTransport } from "../signal.ts"
import { ExecutionId, isWorkflowEvent } from "../schemas.ts"
import { isCancellableRunStatus, statusAfterEvent } from "../run-lifecycle.ts"

export interface TestRuntimeOptions {
  readonly timeSkipping?: boolean
}

export interface CompensationRecorder {
  readonly calls: Array<{ readonly step: string; readonly result: unknown }>
}

export interface TestRuntime {
  mockStep<
    Input extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>,
    Output extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>,
    Errors extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>
  >(
    step: DefinedStep<Input, Output, Errors>,
    impl: (
      input: Input["Type"],
      step: StepContext<Errors["Type"]>
    ) => Promise<Output["Type"] | TerminalFailure<Errors["Type"]>>
  ): void
  failStepOnce<
    Input extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>,
    Output extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>,
    Errors extends SynchronousSchema<Schema.Schema.Type<Schema.Top>>
  >(step: DefinedStep<Input, Output, Errors>): void
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
  sendSignal(executionId: string, name: string, payload: WorkflowPayload): Promise<void>
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
  readonly determinism: InMemoryDeterminismState
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

interface VirtualTimer {
  readonly due: number
  readonly resolve: () => void
}

interface RegisteredStepMock {
  // A decoded schema value is whatever that schema declares, up to a class
  // instance, and the step's own types are erased by the time it reaches here.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters anti-slop/no-unknown-returns
  readonly execute: (input: unknown, context: StepExecutionContext) => Promise<unknown>
}

const nowIso = () => new Date().toISOString()
const executionId = () => crypto.randomUUID()

const statusFromEvent = (event: WorkflowHistoryEvent): WorkflowExecutionStatus | undefined =>
  isWorkflowEvent(event) ? statusAfterEvent(event) : undefined

export const createTestRuntime = (options: TestRuntimeOptions = {}): TestRuntime => {
  const timeSkipping = options.timeSkipping ?? true
  const executions = new Map<string, ExecutionRecord>()
  const idempotencyKeys = new Map<string, string>()
  const stepMocks = new Map<object, RegisteredStepMock>()
  const failOnce = new Set<object>()
  const recorders: CompensationRecorder[] = []
  const timers: VirtualTimer[] = []
  const secrets = new Map<string, string>()
  const signals = createSignalTransport()
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
    const due = virtualNow + Duration.toMillis(Duration.fromInputUnsafe(duration))
    return new Promise((resolve) => {
      timers.push({ due, resolve })
    })
  }

  const executeStepOverride = async (options: {
    readonly step: { readonly name: string }
    readonly input: unknown
    readonly context: StepExecutionContext
  }) => {
    if (failOnce.has(options.step)) {
      failOnce.delete(options.step)
      throw new Error(`Injected failure for step ${options.step.name}`)
    }
    const mock = stepMocks.get(options.step)
    return mock === undefined
      ? { handled: false } as const
      : { handled: true, value: await mock.execute(options.input, options.context) } as const
  }

  const launch = <I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    payload: I,
    record: ExecutionRecord
  ) => {
    void workflow.executeInMemory(payload, {
      executionId: record.executionId,
      signal: record.abort.signal,
      determinism: record.determinism,
      signalTransport: signals,
      stepExecutor: executeStepOverride,
      sleep: ({ duration }) => makeDelay(duration),
      signalTimeout: ({ duration }) => makeDelay(duration),
      secrets: secretResolver,
      onEvent: (event) => {
        appendHistory(record, event)
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
        record.result = { type: "failed", error: record.cancellation ?? error }
        record.resolveResult(record.result)
      }
    )
  }

  const createExecution = <I, O, E>(
    workflow: DefinedWorkflow<I, O, E>,
    payload: I,
    opts: { readonly id?: string; readonly determinism?: InMemoryDeterminismState; readonly actor?: string } = {}
  ): ExecutionRecord => {
    Schema.decodeUnknownSync(workflow.input)(payload)
    let resolveResult!: (result: WorkflowResult) => void
    const resultPromise = new Promise<WorkflowResult>((resolve) => {
      resolveResult = resolve
    })
    const id = opts.id ?? executionId()
    const record: ExecutionRecord = {
      executionId: id,
      determinism: opts.determinism ?? createInMemoryDeterminismState(),
      status: "running",
      startedAt: nowIso(),
      history: [],
      abort: new AbortController(),
      resultPromise,
      resolveResult
    }
    executions.set(id, record)
    appendHistory(record, {
      type: "execution.started",
      executionId: ExecutionId.make(id),
      workflowName: workflow.name,
      payload,
      ...whenPresent("actor", opts.actor)
    })
    launch(workflow, payload, record)
    return record
  }

  return {
    mockStep(step, impl) {
      stepMocks.set(step, {
        execute: async (input, context) => await impl(
          Schema.decodeUnknownSync(step.input)(input),
          {
            ...context,
            fail: terminalFailure
          }
        )
      })
    },

    failStepOnce(step) {
      failOnce.add(step)
    },

    recordCompensations() {
      const recorder: CompensationRecorder = { calls: [] }
      recorders.push(recorder)
      return recorder
    },

    async start(workflow, payload, opts = {}) {
      const workflowKey = workflow.name
      if (opts.idempotencyKey !== undefined) {
        const existingId = idempotencyKeys.get(`${workflowKey}:${opts.idempotencyKey}`)
        if (existingId !== undefined) {
          return { executionId: existingId }
        }
      }
      const record = createExecution(workflow, payload, opts.actor === undefined ? {} : { actor: opts.actor })
      if (opts.idempotencyKey !== undefined) {
        idempotencyKeys.set(`${workflowKey}:${opts.idempotencyKey}`, record.executionId)
      }
      return { executionId: record.executionId }
    },

    async replay(id, workflow, payload) {
      const previous = requireExecution(id)
      const record = createExecution(workflow, payload, {
        id,
        determinism: previous.determinism
      })
      return { executionId: record.executionId }
    },

    sendSignal(executionId, name, payload) {
      return signals.deliver(executionId, name, payload)
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
      if (!isCancellableRunStatus(record.status)) {
        throw new Error(`Cannot cancel ${record.status} execution ${executionId}`)
      }
      const compensate = opts.compensate ?? true
      const cancellation = new Cancelled({ compensate })
      record.cancellation = cancellation
      appendHistory(record, {
        type: "execution.cancelled",
        executionId: ExecutionId.make(executionId),
        compensate,
        ...whenPresent("actor", opts.actor)
      })
      if (compensate) {
        record.status = "compensating"
      }
      signals.cancel(executionId, cancellation)
      if (!compensate) record.abort.abort(cancellation)
    },

    setSecret(name, value) {
      secrets.set(name, value)
    },

    async advanceTime(duration) {
      virtualNow += Duration.toMillis(Duration.fromInputUnsafe(duration))
      timers.sort((left, right) => left.due - right.due)
      for (let index = 0; index < timers.length;) {
        const timer = timers[index]
        if (timer === undefined) break
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
