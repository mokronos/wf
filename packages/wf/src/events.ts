import { Context, Effect } from "effect"
import { WorkflowEvent as WorkflowEventSchema, isWorkflowEvent } from "./schemas.ts"

export { isWorkflowEvent }
export const WorkflowEvent = WorkflowEventSchema
export type WorkflowEvent = typeof WorkflowEventSchema.Type

export type WorkflowEventSink = (event: WorkflowEvent) => void | Promise<void>

export const currentWorkflowEventSink = Context.Reference<WorkflowEventSink | undefined>(
  "wf/currentWorkflowEventSink",
  { defaultValue: () => undefined }
)

// Durable-engine executions run on entity fibers created when the engine
// layer is built, so they do not inherit the caller's context reference. Events that
// carry an executionId are routed through this registry instead.
const executionEventSinks = new Map<string, WorkflowEventSink>()

export const setExecutionEventSink = (executionId: string, sink: WorkflowEventSink): void => {
  executionEventSinks.set(executionId, sink)
}

export const removeExecutionEventSink = (executionId: string): void => {
  executionEventSinks.delete(executionId)
}

export const emitWorkflowEvent = (event: WorkflowEvent): Effect.Effect<void> =>
  Effect.flatMap(currentWorkflowEventSink, (fiberSink) => {
    const executionId = (event as { readonly executionId?: string }).executionId
    const sink = (executionId !== undefined ? executionEventSinks.get(executionId) : undefined) ?? fiberSink
    if (sink === undefined) {
      return Effect.void
    }

    return Effect.promise(() => Promise.resolve(sink(event)))
  })
