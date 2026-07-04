import { mkdirSync } from "node:fs"
import path from "node:path"
import { NodeRuntime } from "@effect/platform-node"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"
import { DurableDeferred, WorkflowEngine } from "effect/unstable/workflow"
import { currentSecretResolver, removeExecutionSecretResolver, setExecutionSecretResolver } from "./core"
import type { DefinedWorkflow, SecretResolver } from "./core"
import {
  currentWorkflowEventSink,
  emitWorkflowEvent,
  removeExecutionEventSink,
  setExecutionEventSink
} from "./events"
import type { WorkflowEventSink } from "./events"

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
  readonly sqliteBusyTimeoutMs?: number
}

export interface WorkflowRuntime {
  readonly backend: "memory" | "sqlite"
  readonly databasePath?: string
  readonly secrets?: SecretResolver
  register(workflows: ReadonlyArray<any>): void
  getWorkflow(name: string, version: number): DefinedWorkflow | undefined
  getLatestWorkflow(name: string): DefinedWorkflow | undefined
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
}

export class WorkflowVersionConflictError extends Error {
  readonly _tag = "WorkflowVersionConflictError"

  constructor(options: { readonly name: string; readonly version: number }) {
    super(
      `Workflow ${options.name}@v${options.version} is already registered with different source; register a new version instead`
    )
    this.name = "WorkflowVersionConflictError"
  }
}

const defaultEngineDatabasePath = () => path.join(process.cwd(), ".wf", "engine.sqlite")

// All durable-execution plumbing lives here so authored workflows never touch
// the cluster engine, the runner, or the backing store.
export const makeEngineLayer = (options: {
  readonly databasePath?: string
  readonly sqliteBusyTimeoutMs?: number
} = {}) => {
  const databasePath = path.resolve(options.databasePath ?? defaultEngineDatabasePath())
  const sqliteBusyTimeoutMs = Math.max(0, Math.trunc(options.sqliteBusyTimeoutMs ?? 5000))
  mkdirSync(path.dirname(databasePath), { recursive: true })
  const sqliteLayer = SqliteClient.layer({ filename: databasePath })
  const configuredSqliteLayer = Layer.effectDiscard(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs}`)
  })).pipe(Layer.provideMerge(sqliteLayer))

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer()),
    Layer.provide(configuredSqliteLayer)
  )
}

export const engineLayer = makeEngineLayer()

export const createWorkflowRuntime = (options: WorkflowRuntimeOptions): WorkflowRuntime => {
  const workflows = new Map<string, DefinedWorkflow>()
  const databasePath = options.databasePath

  const env = () => {
    const workflowLayers = Array.from(workflows.values()).map((workflow) => workflow.layer)
    const base =
      options.backend === "sqlite"
        ? makeEngineLayer({
            ...(databasePath === undefined ? {} : { databasePath }),
            ...(options.sqliteBusyTimeoutMs === undefined ? {} : { sqliteBusyTimeoutMs: options.sqliteBusyTimeoutMs })
          })
        : WorkflowEngine.layerMemory
    return workflowLayers.reduce((layer, workflowLayer) => Layer.provideMerge(workflowLayer, layer), base)
  }

  // ONE engine per runtime. Building a fresh cluster node per call (execute,
  // signal, ...) puts several SingleRunner nodes on the same store, and they
  // fight over shard ownership — message processing becomes arbitrarily late.
  // Rebuilt only when the registered workflow set changes.
  let managed: { readonly signature: string; readonly runtime: ManagedRuntime.ManagedRuntime<any, unknown> } | undefined

  const getManagedRuntime = () => {
    const signature = Array.from(workflows.keys()).sort().join(",")
    if (managed === undefined || managed.signature !== signature) {
      if (managed !== undefined) {
        void managed.runtime.dispose()
      }
      managed = { signature, runtime: ManagedRuntime.make(env()) }
    }
    return managed.runtime
  }

  const runEffect = <A>(effect: Effect.Effect<A, unknown, any>, onEvent?: WorkflowEventSink) =>
    getManagedRuntime().runPromise(
      effect.pipe(
        Effect.provideService(currentWorkflowEventSink, onEvent),
        Effect.provideService(currentSecretResolver, options.secrets)
      ) as Effect.Effect<A, unknown, never>
    )

  return {
    backend: options.backend,
    ...(databasePath === undefined ? {} : { databasePath }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),

    register(registered) {
      for (const workflow of registered) {
        const key = `${workflow.name}@${workflow.version}`
        const existing = workflows.get(key)
        if (existing !== undefined && existing.sourceHash !== workflow.sourceHash) {
          throw new WorkflowVersionConflictError({
            name: workflow.name,
            version: workflow.version
          })
        }
        workflows.set(key, workflow)
      }
    },

    getWorkflow(name, version) {
      return workflows.get(`${name}@${version}`)
    },

    getLatestWorkflow(name) {
      return Array.from(workflows.values())
        .filter((workflow) => workflow.name === name)
        .sort((left, right) => right.version - left.version)[0]
    },

    listWorkflows(name) {
      return Array.from(workflows.values())
        .filter((workflow) => name === undefined || workflow.name === name)
        .sort((left, right) => left.name.localeCompare(right.name) || left.version - right.version)
    },

    execute({ workflow, payload, executionId, onEvent }) {
      const workflowName = String(workflow.workflow._tag ?? workflow.engineName)
      if (onEvent !== undefined) {
        setExecutionEventSink(executionId, onEvent)
      }
      if (options.secrets !== undefined) {
        setExecutionSecretResolver(executionId, options.secrets)
      }
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* emitWorkflowEvent({ type: "workflow.started", workflowName, payload })
        const result = yield* engine.execute(workflow.workflow, {
          executionId,
          payload: payload as any
        }).pipe(
          Effect.tap((result: unknown) =>
            emitWorkflowEvent({ type: "workflow.completed", workflowName, result })
          ),
          Effect.tapError((error: unknown) =>
            emitWorkflowEvent({ type: "workflow.failed", workflowName, error })
          )
        )
        return result
      })
      return runEffect(effect, onEvent).finally(() => {
        removeExecutionEventSink(executionId)
        removeExecutionSecretResolver(executionId)
      })
    },

    deliverSignal({ workflow, executionId, deferredName, payload, onEvent }) {
      if (onEvent !== undefined) {
        setExecutionEventSink(executionId, onEvent)
      }
      // The resumed replay may execute steps in THIS process (see the resume
      // note below), so it needs the secret resolver just like execute().
      if (options.secrets !== undefined) {
        setExecutionSecretResolver(executionId, options.secrets)
      }
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        const deferred = DurableDeferred.make(deferredName, { success: Schema.Unknown })
        yield* engine.deferredDone(deferred, {
          workflowName: workflow.workflow._tag,
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
          yield* engine.resume(workflow.workflow, executionId)
        }
      })
      // The resumed replay may run inside THIS call's engine environment, so
      // it needs the same event sink as the original execute to record
      // history (compensations, cancellation, signal receipt).
      return runEffect(effect, onEvent)
    },

    interrupt({ workflow, executionId }) {
      const effect = Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        yield* engine.interrupt(workflow.workflow, executionId)
      })
      return runEffect(effect)
    }
  }
}

export const makeWorkflowEffect = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) => {
  const env = wf.layer.pipe(
    Layer.provideMerge(makeEngineLayer(
      options.engineDatabasePath === undefined ? {} : { databasePath: options.engineDatabasePath }
    ))
  )
  const workflowName = String(wf.workflow._tag ?? wf.engineName ?? "Workflow")
  const execution = Effect.gen(function* () {
    yield* emitWorkflowEvent({ type: "workflow.started", workflowName, payload })
    const result = yield* wf.workflow.execute(payload).pipe(
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
    Effect.provide(env),
    Effect.provideService(currentWorkflowEventSink, options.onEvent)
  )
}

export const executeWorkflow = (
  wf: DefinedWorkflow,
  payload: unknown,
  options: ExecuteWorkflowOptions = {}
) =>
  Effect.runPromise(
    makeWorkflowEffect(wf, payload, options) as Effect.Effect<unknown, unknown, never>
  )

// Execute a workflow to completion as a standalone program.
export const run = (wf: DefinedWorkflow, payload: unknown) => {
  return (makeWorkflowEffect(wf, payload) as Effect.Effect<unknown, unknown, never>).pipe(
    NodeRuntime.runMain
  )
}
