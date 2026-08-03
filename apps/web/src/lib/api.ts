import {
  decodeRunEventsResponse,
  decodeRunsResponse,
  decodeWorkflowsResponse
} from "@mokronos/wfkit/schemas"
import { decodeIntegrationsResponse, errorPayloadMessage } from "@mokronos/wfkit-executor/schemas"
import type {
  ExecutorAuthMethod,
  ExecutorConnection,
  ExecutorTool,
  IntegrationOverview,
  IntegrationsResponse
} from "@mokronos/wfkit-executor/schemas"
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
  WorkflowHistoryRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowsResponse
} from "@mokronos/wfkit/schemas"

export type {
  ExecutorAuthMethod,
  ExecutorConnection,
  ExecutorTool,
  IntegrationOverview,
  IntegrationsResponse,
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
  WorkflowHistoryRecord,
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

const getIntegrationsJson = async (url: string): Promise<IntegrationsResponse> => {
  const response = await fetch(url)
  const raw: unknown = await response.json()
  const failure = errorPayloadMessage(raw)
  if (failure !== undefined) {
    throw new Error(failure)
  }
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`)
  }
  return decodeIntegrationsResponse(raw)
}

export const workflowKey = (item: WorkflowArtifactGraph): string =>
  item.artifact.id

/**
 * A workflow's name lives in its source, so it arrives with the traced graph.
 * Sources that failed to load have no name to show and fall back to the id.
 */
export const workflowLabel = (item: WorkflowArtifactGraph): string =>
  item.graph?.workflowName ?? item.artifact.id

export const fetchWorkflows = (): Promise<WorkflowsResponse> =>
  getWorkflowsJson("/api/workflows")

export const fetchIntegrations = (): Promise<IntegrationsResponse> =>
  getIntegrationsJson("/api/integrations")

export const fetchRuns = (): Promise<RunsResponse> =>
  getRunsJson("/api/runs")

export const fetchRunEvents = (runId: string): Promise<RunEventsResponse> =>
  getRunEventsJson(`/api/runs/${encodeURIComponent(runId)}/events`)
