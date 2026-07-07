import { Context, Effect } from "effect"

export type WorkflowEvent =
  | {
      readonly type: "workflow.started"
      readonly workflowName: string
      readonly payload: unknown
    }
  | {
      readonly type: "workflow.completed"
      readonly workflowName: string
      readonly result: unknown
    }
  | {
      readonly type: "workflow.failed"
      readonly workflowName: string
      readonly error: unknown
    }
  | {
      readonly type: "step.started"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
      readonly attempt: number
      readonly input: unknown
    }
  | {
      readonly type: "step.completed"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
      readonly attempt: number
      readonly result: unknown
    }
  | {
      readonly type: "step.failed"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
      readonly error: unknown
    }
  | {
      readonly type: "compensation.started"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
      readonly result: unknown
      readonly input: unknown
      readonly reason: unknown
    }
  | {
      readonly type: "compensation.completed"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
    }
  | {
      readonly type: "compensation.failed"
      readonly executionId: string
      readonly stepName: string
      readonly invocation: number
      readonly activityName: string
      readonly error: unknown
    }
  | {
      readonly type: "sleep.started"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly duration: unknown
    }
  | {
      readonly type: "sleep.completed"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly duration: unknown
    }
  | {
      readonly type: "signal.waiting"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly timeout?: unknown
    }
  | {
      readonly type: "signal.received"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly payload: unknown
    }
  | {
      readonly type: "signal.timeout"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly timeout: unknown
    }
  | {
      readonly type: "code.started"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly reason?: string
    }
  | {
      readonly type: "code.completed"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly reason?: string
      readonly result: unknown
    }
  | {
      readonly type: "code.failed"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly reason?: string
      readonly error: unknown
    }
  | {
      readonly type: "all.started"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly branches: number
    }
  | {
      readonly type: "all.completed"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly branches: number
    }
  | {
      readonly type: "all.failed"
      readonly executionId: string
      readonly name: string
      readonly invocation: number
      readonly activityName: string
      readonly branches: number
      readonly error: unknown
    }
  | {
      readonly type: "cancellation.received"
      readonly executionId: string
      readonly compensate: boolean
      readonly actor?: string
    }

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
