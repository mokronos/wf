import type { WorkflowEvent } from "./events.ts"
import type { WorkflowHistoryRecord, WorkflowRunStatus } from "./schemas.ts"

export type { WorkflowHistoryRecord, WorkflowRunStatus }

/** The only event-derived lifecycle transitions. Terminal transitions carry a result or error. */
export const statusAfterEvent = (event: WorkflowEvent): WorkflowRunStatus | undefined => {
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

export const isTerminalRunStatus = (status: WorkflowRunStatus): boolean =>
  status === "completed" || status === "failed"
