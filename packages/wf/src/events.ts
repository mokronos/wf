import { Effect } from "effect"
import { ExecutionResourceRegistry } from "./execution-resources.ts"
import { WorkflowEvent as WorkflowEventSchema, isWorkflowEvent } from "./schemas.ts"

export type WorkflowEventSink = (event: WorkflowEvent) => void | Promise<void>

export { isWorkflowEvent }
export const WorkflowEvent = WorkflowEventSchema
export type WorkflowEvent = typeof WorkflowEventSchema.Type

export const emitWorkflowEvent = (
  event: WorkflowEvent
): Effect.Effect<void, never, ExecutionResourceRegistry> =>
  Effect.gen(function* () {
    const registry = yield* ExecutionResourceRegistry
    const executionId = "executionId" in event ? event.executionId : ""
    const sink = registry.get(executionId ?? "").events
    if (sink === undefined) {
      return
    }
    // A sink is observational. Letting it reject would turn a bad listener
    // into a defect that kills the run it is only meant to watch.
    yield* Effect.tryPromise(() => Promise.resolve(sink(event))).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Workflow event sink failed", cause)
      ),
      Effect.ignore
    )
  })
