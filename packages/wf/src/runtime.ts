import { NodeRuntime } from "@effect/platform-node"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow"
import type { DefinedWorkflow } from "./core.ts"
import type { SecretResolver } from "./secrets.ts"
import {
  emitWorkflowEvent
} from "./events.ts"
import type { WorkflowEventSink } from "./events.ts"
import {
  ExecutionResourceRegistry,
  makeExecutionResourceRegistry
} from "./execution-resources.ts"
import type { IntegrationInvoker } from "./integration-invoker.ts"
import { createConcurrencyLimiter } from "./concurrency.ts"
import type { ConcurrencyLimiter } from "./concurrency.ts"
import { createSignalTransport } from "./signal.ts"
import type { SignalTransport } from "./signal.ts"
import { ExecutionId } from "./schemas.ts"
import { makeEngineLayer } from "./engine-layer.ts"

export { makeEngineLayer } from "./engine-layer.ts"

type DynamicService = Schema.Schema.Type<Schema.Top>

export interface ExecuteWorkflowOptions {
  readonly onEvent?: WorkflowEventSink
  readonly engineDatabasePath?: string
}

export interface WorkflowRuntimeOptions {
  readonly backend: "memory" | "sqlite"
  readonly databasePath?: string
  /** Resolves SecretRef inputs to their values at step execution time.
   *  Only the reference string is ever persisted. */
  readonly secrets?: SecretResolver
  /** Concrete adapter used by provider-neutral integration steps. */
  readonly integrations?: IntegrationInvoker
  readonly sqliteBusyTimeoutMs?: number
  /** How often the engine polls storage for due timers and undelivered
   *  messages. Durable timers (signal timeouts, long sleeps) can fire up to
   *  one interval late. Defaults to 250ms. */
  readonly timerPollIntervalMs?: number
}

export interface WorkflowRuntime {
  readonly backend: "memory" | "sqlite"
  readonly databasePath?: string
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency: ConcurrencyLimiter
  readonly signals: SignalTransport
  register(workflows: ReadonlyArray<DefinedWorkflow>): void
  getWorkflow(name: string): DefinedWorkflow | undefined
  listWorkflows(name?: string): ReadonlyArray<DefinedWorkflow>
  execute(options: {
    readonly workflow: DefinedWorkflow
    readonly payload: unknown
    readonly executionId: string
    readonly onEvent?: WorkflowEventSink
  }): Promise<unknown>
  deliverSignal(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
    readonly deferredName: string
    readonly payload: unknown
    readonly onEvent?: WorkflowEventSink
  }): Promise<void>
  interrupt(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
  }): Promise<void>
  /** Wake a suspended execution so it replays to its suspension point.
   *  No-op unless the run is recorded as suspended. */
  resume(options: {
    readonly workflow: DefinedWorkflow
    readonly executionId: string
  }): Promise<void>
  /** Releases the engine and its SQLite resources. A disposed runtime cannot be reused. */
  dispose(): Promise<void>
}

export class WorkflowConflictError extends Schema.TaggedErrorClass<WorkflowConflictError>()(
  "WorkflowConflictError",
  { workflowName: Schema.String }
) {
  override get message(): string {
    return `Workflow ${this.workflowName} is already registered with different source`
  }
}

export const createWorkflowRuntime = (options: WorkflowRuntimeOptions): WorkflowRuntime => {
  const workflows = new Map<string, DefinedWorkflow>()
  const concurrency = createConcurrencyLimiter()
  const signals = createSignalTransport()
  const registeredExecutionIds = new Set<string>()
  const databasePath = options.databasePath
  const resourceRegistry = makeExecutionResourceRegistry({
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
    concurrency,
    signals
  })

  const registerResources = (
    executionId: string,
    onEvent?: WorkflowEventSink
  ): void => {
    resourceRegistry.register(executionId, {
      ...(onEvent === undefined ? {} : { events: onEvent }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
      concurrency,
      signals
    })
    registeredExecutionIds.add(executionId)
  }

  const removeResources = (executionId: string): void => {
    resourceRegistry.remove(executionId)
    registeredExecutionIds.delete(executionId)
  }

  const env = () => {
    const workflowLayers = Array.from(workflows.values()).map((workflow) => workflow.layer)
    const base =
      options.backend === "sqlite"
        ? makeEngineLayer({
            ...(databasePath === undefined ? {} : { databasePath }),
            ...(options.sqliteBusyTimeoutMs === undefined ? {} : { sqliteBusyTimeoutMs: options.sqliteBusyTimeoutMs }),
            ...(options.timerPollIntervalMs === undefined ? {} : { timerPollIntervalMs: options.timerPollIntervalMs })
          })
        : WorkflowEngine.layerMemory
    const runtimeDependencies = Layer.merge(
      base,
      Layer.succeed(ExecutionResourceRegistry, resourceRegistry)
    )
    return workflowLayers.reduce(
      (layer, workflowLayer) => Layer.provideMerge(workflowLayer, layer),
      runtimeDependencies
    )
  }

  // Reuse one engine for each immutable workflow registry snapshot. Old
  // snapshots stay alive until runtime disposal so registering a workflow
  // cannot tear resources out from under an active execution.
  const managedBySignature = new Map<
    string,
    ManagedRuntime.ManagedRuntime<
      WorkflowEngine.WorkflowEngine | ExecutionResourceRegistry,
      DynamicService
    >
  >()
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const ensureActive = (): void => {
    if (disposed) {
      throw new Error("Workflow runtime has been disposed")
    }
  }

  const getManagedRuntime = () => {
    ensureActive()
    const signature = Array.from(workflows.keys()).sort().join(",")
    const existing = managedBySignature.get(signature)
    if (existing !== undefined) return existing
    const created = ManagedRuntime.make(env())
    managedBySignature.set(signature, created)
    return created
  }

  const runEffect = <A>(
    effect: Effect.Effect<
      A,
      DynamicService,
      WorkflowEngine.WorkflowEngine | ExecutionResourceRegistry
    >
  ) =>
    getManagedRuntime().runPromise(effect)

  return {
    backend: options.backend,
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
    concurrency,
    signals,

    register(registered) {
      ensureActive()
      for (const workflow of registered) {
        const existing = workflows.get(workflow.name)
        if (existing !== undefined && existing.sourceHash !== workflow.sourceHash) {
          throw new WorkflowConflictError({ workflowName: workflow.name })
        }
        workflows.set(workflow.name, workflow)
      }
    },

    getWorkflow(name) {
      return workflows.get(name)
    },

    listWorkflows(name) {
      return Array.from(workflows.values())
        .filter((workflow) => name === undefined || workflow.name === name)
        .sort((left, right) => left.name.localeCompare(right.name))
    },

    async execute({ workflow, payload, executionId, onEvent }) {
      Schema.decodeUnknownSync(workflow.input)(payload)
      const workflowName = String(workflow.workflow.name ?? workflow.name)
      registerResources(executionId, onEvent)
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* emitWorkflowEvent({ type: "workflow.started", executionId: ExecutionId.make(executionId), workflowName, payload })
        const result = yield* workflow.workflow.execute(
          engine,
          executionId,
          payload
        ).pipe(
          Effect.tap((result: unknown) =>
            emitWorkflowEvent({ type: "workflow.completed", executionId: ExecutionId.make(executionId), workflowName, result })
          ),
          Effect.tapError((error: unknown) =>
            emitWorkflowEvent({ type: "workflow.failed", executionId: ExecutionId.make(executionId), workflowName, error })
          )
        )
        return result
      })
      return await runEffect(effect).finally(() => {
        removeResources(executionId)
      })
    },

    deliverSignal({ workflow, executionId, deferredName, payload, onEvent }) {
      // The resumed replay may execute steps in THIS process, so all execution
      // resources are registered together before the wake-up.
      registerResources(executionId, onEvent)
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const deferred = DurableDeferred.make(deferredName, { success: Schema.Unknown })
        yield* engine.deferredDone(deferred, {
          workflowName: workflow.workflow.name,
          executionId,
          deferredName,
          exit: Exit.succeed(payload)
        })
        // deferredDone only resumes a run whose Suspended reply is already
        // persisted. A delivery racing the suspension write would otherwise
        // sit unnoticed until another wake-up, so nudge resume a few times
        // (resume is a no-op unless the run is recorded as suspended).
        for (let attempt = 0; attempt < 5; attempt++) {
          yield* Effect.sleep("100 millis")
          yield* workflow.workflow.resume(engine, executionId)
        }
      })
      // The resumed replay may run inside THIS call's engine environment, so
      // it needs the same event sink as the original execute to record
      // history (compensations, cancellation, signal receipt).
      return runEffect(effect)
    },

    interrupt({ workflow, executionId }) {
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* workflow.workflow.interrupt(engine, executionId)
      })
      return runEffect(effect)
    },

    resume({ workflow, executionId }) {
      registerResources(executionId)
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* workflow.workflow.resume(engine, executionId)
      })
      return runEffect(effect)
    },

    async dispose() {
      if (disposePromise !== undefined) return disposePromise
      disposed = true
      disposePromise = (async () => {
        for (const executionId of registeredExecutionIds) {
          resourceRegistry.remove(executionId)
        }
        registeredExecutionIds.clear()
        resourceRegistry.clear()
        const active = Array.from(managedBySignature.values())
        managedBySignature.clear()
        await Promise.all(active.map((runtime) => runtime.dispose()))
      })()
      await disposePromise
    }
  }
}

export const makeWorkflowEffect = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) => {
  const resources = makeExecutionResourceRegistry(
    options.onEvent === undefined ? {} : { events: options.onEvent }
  )
  const env = wf.layer.pipe(
    Layer.provideMerge(makeEngineLayer(
      options.engineDatabasePath === undefined ? {} : { databasePath: options.engineDatabasePath }
    )),
    Layer.provideMerge(Layer.succeed(ExecutionResourceRegistry, resources))
  )
  const workflowName = String(wf.workflow.name ?? wf.name ?? "Workflow")
  const execution = Effect.gen(function* () {
    Schema.decodeUnknownSync(wf.input)(payload)
    yield* emitWorkflowEvent({ type: "workflow.started", workflowName, payload })
    const result = yield* wf.workflow.executeStandalone({ value: payload }).pipe(
      Effect.tap((result: unknown) =>
        emitWorkflowEvent({ type: "workflow.completed", workflowName, result })
      ),
      Effect.tapError((error: unknown) =>
        emitWorkflowEvent({ type: "workflow.failed", workflowName, error })
      )
    )
    return result
  })

  return execution.pipe(
    Effect.provide(env)
  )
}

export const executeWorkflow = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) => Effect.runPromise(makeWorkflowEffect(wf, payload, options))

// Execute a workflow to completion as a standalone program.
export const run = (wf: DefinedWorkflow, payload: unknown) => {
  return makeWorkflowEffect(wf, payload).pipe(
    NodeRuntime.runMain
  )
}
