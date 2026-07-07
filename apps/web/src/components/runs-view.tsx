import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, RefreshCw, ServerCrash } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RunTimeline } from "@/components/run-timeline"
import { useApi } from "@/hooks/use-api"
import { fetchRunEvents, type WorkflowRunRecord, type WorkflowRunStatus } from "@/lib/api"
import { compactDate, durationBetween, prettyJson, shortId } from "@/lib/format"
import { cn } from "@/lib/utils"

const statusVariant = (status: WorkflowRunStatus): "secondary" | "destructive" | "outline" =>
  status === "failed" ? "destructive" : status === "running" ? "outline" : "secondary"

export function RunsView({
  runs,
  loading,
  error,
  generatedAt,
  onReload
}: {
  readonly runs: ReadonlyArray<WorkflowRunRecord>
  readonly loading: boolean
  readonly error: string | undefined
  readonly generatedAt: string | undefined
  readonly onReload: () => Promise<void>
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const orderedRuns = useMemo(
    () => [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [runs]
  )
  const selected = orderedRuns.find((run) => run.id === selectedId) ?? orderedRuns[0]

  useEffect(() => {
    setSelectedId(selected?.id)
  }, [selected?.id])

  const loadEvents = useCallback(async () => {
    if (selected === undefined) {
      return undefined
    }
    return fetchRunEvents(selected.id)
  }, [selected])
  const eventsState = useApi(loadEvents, selected !== undefined)

  return (
    <section className="workbench runs-workbench">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">execution history</p>
          <h2>Runs</h2>
        </div>
        <div className="topbar-actions">
          <span className="updated-at light">
            {generatedAt === undefined ? "" : `updated ${compactDate(generatedAt)}`}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={() => void onReload()} disabled={loading}>
                <RefreshCw className={cn(loading && "animate-spin")} aria-hidden="true" />
                <span className="sr-only">Refresh runs</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh runs</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Could not load runs</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="runs-layout">
        <Card className="runs-list-card">
          <CardHeader>
            <CardTitle>Run History</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="stack">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : orderedRuns.length === 0 ? (
              <div className="empty-panel light-panel">
                <ServerCrash aria-hidden="true" />
                <p>No runs found.</p>
                <span>Workflow executions will appear here.</span>
              </div>
            ) : (
              <div className="run-table" role="list">
                {orderedRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    role="listitem"
                    onClick={() => setSelectedId(run.id)}
                    className={cn("run-row", selected?.id === run.id && "active")}
                  >
                    <span className="run-main">
                      <code>{shortId(run.id)}</code>
                      <strong>{run.workflowId}@{run.workflowVersion}</strong>
                    </span>
                    <StatusBadge status={run.status} />
                    <span>{compactDate(run.startedAt)}</span>
                    <span>{compactDate(run.finishedAt)}</span>
                    <span>{durationBetween(run.startedAt, run.finishedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="run-detail">
          <RunSummary run={eventsState.data?.run ?? selected} />
          <Card className="timeline-card-shell">
            <CardHeader>
              <CardTitle>Event Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <RunTimeline
                events={eventsState.data?.events ?? []}
                loading={eventsState.loading}
                error={eventsState.error}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

function StatusBadge({ status }: { readonly status: WorkflowRunStatus }) {
  return (
    <Badge variant={statusVariant(status)} className={cn("status-badge", `status-${status}`)}>
      {status}
    </Badge>
  )
}

function RunSummary({ run }: { readonly run: WorkflowRunRecord | undefined }) {
  if (run === undefined) {
    return (
      <Card>
        <CardContent className="run-summary-empty">Select a run to inspect its input and result.</CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {shortId(run.id)} <StatusBadge status={run.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="run-summary-grid">
        <div>
          <span>Workflow</span>
          <strong>{run.workflowId}@{run.workflowVersion}</strong>
        </div>
        <div>
          <span>Started</span>
          <strong>{compactDate(run.startedAt)}</strong>
        </div>
        <div>
          <span>Duration</span>
          <strong>{durationBetween(run.startedAt, run.finishedAt)}</strong>
        </div>
        <details>
          <summary>Input</summary>
          <pre>{prettyJson(run.input)}</pre>
        </details>
        {run.result === undefined ? null : (
          <details>
            <summary>Result</summary>
            <pre>{prettyJson(run.result)}</pre>
          </details>
        )}
        {run.error === undefined ? null : (
          <details>
            <summary>Error</summary>
            <pre>{prettyJson(run.error)}</pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
