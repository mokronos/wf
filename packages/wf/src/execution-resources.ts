import { Context, Layer } from "effect"
import type { SecretResolver } from "./secrets.ts"
import type { WorkflowEventSink } from "./event-sink.ts"
import type { IntegrationInvoker } from "./integration-contract.ts"
import type { ConcurrencyLimiter } from "./concurrency.ts"
import type { SignalTransport } from "./signal.ts"

/** Replaceable dependencies owned by one workflow execution. Keeping them in
 * one record gives the runtime one registration and cleanup lifecycle. */
export interface ExecutionResources {
  readonly events?: WorkflowEventSink
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency?: ConcurrencyLimiter
  readonly signals?: SignalTransport
}

export interface ExecutionResourceRegistryService {
  readonly register: (executionId: string, resources: ExecutionResources) => void
  readonly remove: (executionId: string) => void
  readonly get: (executionId: string) => ExecutionResources
  readonly clear: () => void
}

export class ExecutionResourceRegistry extends Context.Service<
  ExecutionResourceRegistry,
  ExecutionResourceRegistryService
>()("@mokronos/wfkit/ExecutionResourceRegistry") {
  /** The capability as a Layer. Anything living entirely inside Effect should
   *  wire this rather than building the registry itself. */
  static readonly layer = (
    defaults: ExecutionResources = {}
  ): Layer.Layer<ExecutionResourceRegistry> =>
    Layer.sync(ExecutionResourceRegistry, () => createExecutionResourceRegistry(defaults))

  /** Wires an already-built registry. `createWorkflowRuntime` needs this: its
   *  façade registers and removes per-execution resources from ordinary
   *  synchronous code, so it has to hold the very instance the Layer provides
   *  rather than letting the Layer construct its own. */
  static readonly layerOf = (
    registry: ExecutionResourceRegistryService
  ): Layer.Layer<ExecutionResourceRegistry> =>
    Layer.succeed(ExecutionResourceRegistry, registry)
}

/** Builds the registry itself. Prefer `ExecutionResourceRegistry.layer`; this
 *  exists for the imperative façade described on `layerOf`. */
export const createExecutionResourceRegistry = (
  defaults: ExecutionResources = {}
): ExecutionResourceRegistryService => {
  const resourcesByExecution = new Map<string, ExecutionResources>()
  return {
    register: (executionId, resources) => {
      resourcesByExecution.set(executionId, resources)
    },
    remove: (executionId) => {
      resourcesByExecution.delete(executionId)
    },
    get: (executionId) => ({
      ...defaults,
      ...resourcesByExecution.get(executionId)
    }),
    clear: () => {
      resourcesByExecution.clear()
    }
  }
}
