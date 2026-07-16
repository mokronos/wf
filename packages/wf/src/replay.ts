import type { WorkflowHistoryEvent } from "./schemas.ts"

// Events emitted from workflow-position code (as opposed to inside an
// activity) fire again every time the durable engine replays an execution —
// e.g. when a suspended run resumes after a signal, possibly in a fresh
// process. History sinks use this identity to record each such event once.
// Step, code, and compensation events are emitted inside activities or
// finalizers, never replayed, and legitimately repeat across retry attempts,
// so they have no dedupe identity.
export const replayDedupeKey = (event: WorkflowHistoryEvent): string | undefined => {
  switch (event.type) {
    case "workflow.started":
    case "workflow.completed":
    case "workflow.failed":
    case "cancellation.received":
      return event.type
    case "sleep.started":
    case "sleep.completed":
    case "signal.waiting":
    case "signal.received":
    case "signal.timeout":
    case "all.started":
    case "all.completed":
    case "all.failed":
      return `${event.type}:${event.activityName}`
    default:
      return undefined
  }
}
