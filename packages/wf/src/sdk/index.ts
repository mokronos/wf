export { createMemoryWorkflowStore } from "./artifact.ts"
export type {
  WorkflowArtifact,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStore
} from "./artifact.ts"
export {
  createDirectoryWorkflowCatalog,
  parseWorkflowId,
  workflowIdFromFilename
} from "./catalog.ts"
export type { WorkflowCatalog, WorkflowCatalogOptions } from "./catalog.ts"
export type { WorkflowId } from "../schemas.ts"
export {
  createWorkflowSourceStore,
  hashWorkflowSource,
  parseWorkflowSourceHash,
  WorkflowSourceHash
} from "./sources.ts"
export type { WorkflowSourceStore, WorkflowSourceStoreOptions } from "./sources.ts"
export {
  isDefinedWorkflow,
  loadWorkflowArtifact,
  validateWorkflowArtifact
} from "./loader.ts"
export type { ArtifactValidation, LoadedWorkflow } from "./loader.ts"
export {
  sampleValueForJsonSchema,
  sampleValueForSchema,
  workflowArtifactToGraph,
  workflowToGraph
} from "./graph.ts"
export type {
  WorkflowArtifactGraph,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeMetadata,
  WorkflowGraphNodeSchemas,
  WorkflowGraphSchemas,
  WorkflowGraphOptions
} from "./graph.ts"
export { parseJsonText, toJsonText } from "./json.ts"
export { Cancelled }
export type {
  WorkflowClient,
  WorkflowExecutionHandle,
  WorkflowExecutionRecord,
  WorkflowExecutionStatus,
  WorkflowHistoryEvent,
  WorkflowHistoryRecord,
  WorkflowListResult,
  PendingSignal,
  WorkflowResult,
  WorkflowObservation
} from "./client-model.ts"

export const lifecycleRunRecords = async (
  client: WorkflowClient,
  artifacts: ReadonlyArray<WorkflowArtifact>
): Promise<ReadonlyArray<WorkflowRunRecord>> =>
  (await client.executions()).map((execution) => {
    const artifact = artifacts.find((candidate) => candidate.id === execution.artifactId)
    return {
      id: ExecutionId.make(execution.executionId),
      workflowId: artifact?.id ?? execution.workflowName,
      status: execution.status,
      input: execution.payload,
      startedAt: execution.startedAt,
      ...whenPresent("finishedAt", execution.finishedAt)
    }
  })

export const createWorkflowClient = (
  runtime: WorkflowRuntime = createWorkflowRuntime({ backend: "memory" })
): WorkflowClient =>
  runtime.backend === "sqlite"
    ? createDurableWorkflowClient(runtime)
    : createMemoryWorkflowClient(runtime)
import { whenPresent } from "../optional.ts"
import { Cancelled } from "../core.ts"
import { ExecutionId } from "../schemas.ts"
import { createWorkflowRuntime } from "../runtime.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import type { WorkflowArtifact, WorkflowRunRecord } from "./artifact.ts"
import type { WorkflowClient } from "./client-model.ts"
import { createDurableWorkflowClient } from "./durable-client.ts"
import { createMemoryWorkflowClient } from "./memory-client.ts"
