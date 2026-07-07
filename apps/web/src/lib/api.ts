import type {
  WorkflowArtifactGraph,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeSchemas,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus
} from "wf"
import type { WorkflowEvent } from "wf"

export type {
  WorkflowArtifactGraph,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeSchemas,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowEvent
}

export interface WorkflowsResponse {
  readonly generatedAt: string
  readonly workflows: ReadonlyArray<WorkflowArtifactGraph>
  readonly error?: string
}

export interface RunsResponse {
  readonly generatedAt: string
  readonly runs: ReadonlyArray<WorkflowRunRecord>
  readonly error?: string
}

export interface RunEventsResponse {
  readonly generatedAt: string
  readonly run: WorkflowRunRecord
  readonly events: ReadonlyArray<WorkflowRunEventRecord>
  readonly error?: string
}

const getJson = async <T extends { readonly error?: string }>(url: string): Promise<T> => {
  const response = await fetch(url)
  const payload = await response.json() as T
  if (!response.ok || payload.error !== undefined) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`)
  }
  return payload
}

export const workflowKey = (item: WorkflowArtifactGraph): string =>
  `${item.artifact.id}@${item.artifact.version}`

export const fetchWorkflows = (): Promise<WorkflowsResponse> =>
  getJson<WorkflowsResponse>("/api/workflows")

export const fetchRuns = (): Promise<RunsResponse> =>
  getJson<RunsResponse>("/api/runs")

export const fetchRunEvents = (runId: string): Promise<RunEventsResponse> =>
  getJson<RunEventsResponse>(`/api/runs/${encodeURIComponent(runId)}/events`)
