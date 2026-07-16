import { AlertTriangle, Braces, CircleDot, Clock3, GitCommitVertical, Radio, RotateCcw, Workflow } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import type { WorkflowEvent, WorkflowHistoryEvent, WorkflowRunEventRecord } from "@/lib/api"
import { compactDate, prettyJson } from "@/lib/format"
import { cn } from "@/lib/utils"

type EventFamily = "step" | "sleep" | "signal" | "code" | "compensation" | "workflow" | "other"

const familyIcon = {
  step: CircleDot,
  sleep: Clock3,
  signal: Radio,
  code: Braces,
  compensation: RotateCcw,
  workflow: Workflow,
  other: GitCommitVertical
} satisfies Record<EventFamily, typeof CircleDot>

const eventFamily = (type: string): EventFamily => {
  const family = type.split(".")[0]
  if (
    family === "step" ||
    family === "sleep" ||
    family === "signal" ||
    family === "code" ||
    family === "compensation" ||
    family === "workflow"
  ) {
    return family
  }
  return "other"
}

const scalar = (value: unknown): string | undefined =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : undefined

const isWorkflowEvent = (event: WorkflowHistoryEvent): event is WorkflowEvent => {
  switch (event.type) {
    case "execution.started":
    case "signal.delivered":
    case "execution.cancelled":
      return false
    default:
      return true
  }
}

const eventName = (event: WorkflowHistoryEvent): string | undefined => {
  switch (event.type) {
    case "workflow.started":
    case "workflow.completed":
    case "workflow.failed":
    case "execution.started":
      return event.workflowName
    case "step.started":
    case "step.completed":
    case "step.failed":
    case "compensation.started":
    case "compensation.completed":
    case "compensation.failed":
      return event.stepName
    case "cancellation.received":
    case "execution.cancelled":
      return undefined
    case "signal.delivered":
      return event.name
    default:
      return event.name
  }
}

const payloadChips = (record: WorkflowRunEventRecord): ReadonlyArray<[string, string]> => {
  const event = record.event
  const chips: Array<[string, string]> = []
  const name = eventName(event)
  const attempt = isWorkflowEvent(event) && "attempt" in event ? scalar(event.attempt) : undefined
  const invocation = isWorkflowEvent(event) && "invocation" in event ? scalar(event.invocation) : undefined
  const reason = isWorkflowEvent(event) && "reason" in event ? scalar(event.reason) : undefined
  const duration = isWorkflowEvent(event) && "duration" in event
    ? scalar(event.duration)
    : isWorkflowEvent(event) && "timeout" in event
      ? scalar(event.timeout)
      : undefined
  if (name !== undefined) chips.push(["name", name])
  if (attempt !== undefined) chips.push(["attempt", attempt])
  if (invocation !== undefined) chips.push(["invocation", invocation])
  if (duration !== undefined) chips.push(["duration", duration])
  if (reason !== undefined) chips.push(["reason", reason])
  if ("payload" in event && event.payload !== undefined) chips.push(["payload", prettyJson(event.payload)])
  if ("error" in event && event.error !== undefined) chips.push(["error", prettyJson(event.error)])
  return chips
}

export function RunTimeline({
  events,
  loading,
  error
}: {
  readonly events: ReadonlyArray<WorkflowRunEventRecord>
  readonly loading: boolean
  readonly error: string | undefined
}) {
  if (loading) {
    return (
      <div className="timeline">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }

  if (error !== undefined) {
    return (
      <div className="empty-canvas runs-empty">
        <AlertTriangle aria-hidden="true" />
        <h3>Could not load run events</h3>
        <p>{error}</p>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="empty-canvas runs-empty">
        <GitCommitVertical aria-hidden="true" />
        <h3>No events recorded</h3>
        <p>This run does not have an event history yet.</p>
      </div>
    )
  }

  return (
    <ol className="timeline">
      {events.map((record) => {
        const family = eventFamily(record.type)
        const Icon = familyIcon[family]
        const chips = payloadChips(record)
        return (
          <li key={`${record.runId}:${record.sequence}`} className={cn("timeline-item", `event-${family}`)}>
            <div className="timeline-marker">
              <Icon aria-hidden="true" />
            </div>
            <div className="timeline-card">
              <div className="timeline-head">
                <Badge variant="outline">#{record.sequence}</Badge>
                <strong>{record.type}</strong>
                <span>{compactDate(record.createdAt)}</span>
              </div>
              {chips.length === 0 ? null : (
                <div className="event-chip-grid">
                  {chips.map(([key, value]) => (
                    <span key={`${record.sequence}:${key}`} className={cn(key === "reason" && "event-reason-chip")}>
                      <b>{key}</b>
                      <code>{value}</code>
                    </span>
                  ))}
                </div>
              )}
              <details className="event-details">
                <summary>Raw event</summary>
                <pre>{prettyJson(record.event)}</pre>
              </details>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
