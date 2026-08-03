import type {
  WorkflowArtifact,
  WorkflowRunRecord,
  WorkflowRunStatus
} from "../schemas.ts"

export type { WorkflowArtifact, WorkflowRunRecord, WorkflowRunStatus }

/** Read access to a set of workflow sources, however they are stored. */
export interface WorkflowStore {
  list(): Promise<ReadonlyArray<WorkflowArtifact>>
  get(id: string): Promise<WorkflowArtifact | undefined>
}

export const createMemoryWorkflowStore = (
  workflows: ReadonlyArray<WorkflowArtifact>
): WorkflowStore => {
  const artifacts = workflows.map((workflow) => ({ ...workflow }))

  return {
    async list() {
      return artifacts
    },

    async get(id) {
      return artifacts.find((workflow) => workflow.id === id)
    }
  }
}
