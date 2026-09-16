import type { Layer, Schema } from "effect"
import type * as Duration from "effect/Duration"
import type { WorkflowEngine } from "effect/unstable/workflow"
import type { ConcurrencyLimiter } from "./concurrency.ts"
import type { InMemoryDeterminismState } from "./determinism.ts"
import type { WorkflowEvent } from "./schemas.ts"
import type { SecretResolver } from "./secrets.ts"
import type { SignalTransport } from "./signal.ts"
import type { ExecutionResourceRegistry } from "./execution-resources.ts"
import type {
  DynamicService,
  StepExecutionContext,
  StepRetryPolicy,
  SynchronousSchema
} from "./workflow-model.ts"
import type { SerializableValue } from "./schemas.ts"

export const DefinedWorkflowTypeId = Symbol.for("wf/DefinedWorkflow")

export interface WorkflowEngineHandle {
  readonly name: string
  readonly execute: (engine: WorkflowEngine.WorkflowEngine["Service"], executionId: string, payload: DynamicService) => import("effect").Effect.Effect<DynamicService, DynamicService>
  readonly executeStandalone: (payload: DynamicService) => import("effect").Effect.Effect<DynamicService, DynamicService, WorkflowEngine.WorkflowEngine>
  readonly resume: (engine: WorkflowEngine.WorkflowEngine["Service"], executionId: string) => import("effect").Effect.Effect<void>
  readonly interrupt: (engine: WorkflowEngine.WorkflowEngine["Service"], executionId: string) => import("effect").Effect.Effect<void>
}

export interface InMemoryExecutionOptions {
  readonly executionId?: string
  readonly signal?: AbortSignal
  readonly determinism?: InMemoryDeterminismState
  readonly onEvent?: (event: WorkflowEvent) => void | Promise<void>
  readonly stepExecutor?: (options: { readonly step: InspectableStep; readonly input: unknown; readonly invocation: number; readonly activityName: string; readonly context: StepExecutionContext }) => StepExecutionOverride | Promise<StepExecutionOverride>
  readonly sleep?: (options: { readonly executionId: string; readonly name: string; readonly duration: Duration.Input }) => Promise<void>
  readonly signalTimeout?: (options: { readonly executionId: string; readonly name: string; readonly duration: Duration.Input }) => Promise<void>
  readonly signalValue?: (options: { readonly executionId: string; readonly name: string; readonly schema: SynchronousSchema<DynamicService> }) => SerializableValue | Promise<SerializableValue>
  readonly signalTransport?: SignalTransport
  readonly secrets?: SecretResolver
  readonly concurrency?: ConcurrencyLimiter
}

export interface InspectableStep {
  readonly name: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly errors: Schema.Top
  readonly retry?: StepRetryPolicy
  readonly concurrency?: { readonly limit: number; readonly key?: object }
  readonly compensate?: object
}

export type StepExecutionOverride = { readonly handled: false } | { readonly handled: true; readonly value: unknown }

export interface WorkflowDefinition<Input extends SynchronousSchema<DynamicService>, Output extends SynchronousSchema<DynamicService>, Errors extends SynchronousSchema<DynamicService>> {
  readonly [DefinedWorkflowTypeId]: typeof DefinedWorkflowTypeId
  readonly name: string
  readonly sourceHash: string
  readonly input: Input
  readonly output: Output
  readonly errors: Errors
  readonly workflow: WorkflowEngineHandle
  readonly layer: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine | ExecutionResourceRegistry>
  execute(payload: Input["Type"]): import("effect").Effect.Effect<Output["Type"], Errors["Type"] | unknown, WorkflowEngine.WorkflowEngine>
  executeInMemory(payload: Input["Type"], options?: InMemoryExecutionOptions): Promise<Output["Type"]>
}

export type DefinedWorkflow<I = DynamicService, O = DynamicService, WErrors = DynamicService> = WorkflowDefinition<SynchronousSchema<I>, SynchronousSchema<O>, SynchronousSchema<WErrors>>
