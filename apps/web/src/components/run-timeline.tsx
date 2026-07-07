import { AlertTriangle, Braces, CircleDot, Clock3, GitCommitVertical, Radio, RotateCcw, Workflow } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import type { WorkflowRunEventRecord } from "@/lib/api"
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

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const field = (event: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  for (const key of keys) {
    const value = event[key]
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value)
    }
  }
  return undefined
}

const payloadChips = (record: WorkflowRunEventRecord): ReadonlyArray<[string, string]> => {
  const event = asRecord(record.event)
  const chips: Array<[string, string]> = []
  const name = field(event, ["stepName", "name", "workflowName"])
  const attempt = field(event, ["attempt"])
  const invocation = field(event, ["invocation"])
  const reason = field(event, ["reason"])
  const duration = field(event, ["duration", "timeout"])
  if (name !== undefined) chips.push(["name", name])
  if (attempt !== undefined) chips.push(["attempt", attempt])
  if (invocation !== undefined) chips.push(["invocation", invocation])
  if (duration !== undefined) chips.push(["duration", duration])
  if (reason !== undefined) chips.push(["reason", reason])
  if (event.payload !== undefined) chips.push(["payload", prettyJson(event.payload)])
  if (event.error !== undefined) chips.push(["error", prettyJson(event.error)])
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
