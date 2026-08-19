import { whenPresent } from "../optional.ts"
import { Cancelled } from "../core.ts"
import { ExecutionId } from "../schemas.ts"
import { createWorkflowRuntime } from "../runtime.ts"
import type { WorkflowRuntime } from "../runtime.ts"
import type { WorkflowArtifact, WorkflowRunRecord } from "./artifact.ts"
import type { WorkflowClient } from "./client-model.ts"
import { createDurableWorkflowClient } from "./durable-client.ts"
import { createMemoryWorkflowClient } from "./memory-client.ts"

export type * from "./client-model.ts"
export { pendingSignalsFromHistory } from "./client-lifecycle.ts"
export { Cancelled }

/** Catalog artifacts annotate executions; lifecycle state itself stays engine-owned. */
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
