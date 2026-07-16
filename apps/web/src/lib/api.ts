import {
  decodeRunEventsResponse,
  decodeRunsResponse,
  decodeWorkflowsResponse
} from "wf/schemas"
import type {
  RunEventsResponse,
  RunsResponse,
  WorkflowArtifactGraph,
  WorkflowEvent,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeMetadata,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeSchemas,
  WorkflowHistoryEvent,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowsResponse
} from "wf/schemas"

export type {
  RunEventsResponse,
  RunsResponse,
  WorkflowArtifactGraph,
  WorkflowGraphNodeMetadata,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeSchemas,
  WorkflowHistoryEvent,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowEvent,
  WorkflowsResponse
}

const throwForError = (
  response: Response,
  payload: { readonly error?: string }
): void => {
  if (!response.ok || payload.error !== undefined) {
    throw new Error(payload.error ?? `Request failed with ${response.status}`)
  }
}

const getWorkflowsJson = async (url: string): Promise<WorkflowsResponse> => {
  const response = await fetch(url)
  const raw: unknown = await response.json()
  const payload = decodeWorkflowsResponse(raw)
  throwForError(response, payload)
  return payload
}

const getRunsJson = async (url: string): Promise<RunsResponse> => {
  const response = await fetch(url)
  const raw: unknown = await response.json()
  const payload = decodeRunsResponse(raw)
  throwForError(response, payload)
  return payload
}

const getRunEventsJson = async (url: string): Promise<RunEventsResponse> => {
  const response = await fetch(url)
  const raw: unknown = await response.json()
  const payload = decodeRunEventsResponse(raw)
  throwForError(response, payload)
  return payload
}

export const workflowKey = (item: WorkflowArtifactGraph): string =>
  `${item.artifact.id}@${item.artifact.version}`

export const fetchWorkflows = (): Promise<WorkflowsResponse> =>
  getWorkflowsJson("/api/workflows")

export const fetchRuns = (): Promise<RunsResponse> =>
  getRunsJson("/api/runs")

export const fetchRunEvents = (runId: string): Promise<RunEventsResponse> =>
  getRunEventsJson(`/api/runs/${encodeURIComponent(runId)}/events`)
