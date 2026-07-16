import { createWorkflowClient, createWorkflowRuntime, envSecretResolver } from "@mokronos/wfkit"
import { XEngagementWorkflow } from "./workflow"

export const runtime = createWorkflowRuntime({
  backend: "sqlite",
  databasePath: ".wf/x-engagement.sqlite",
  secrets: envSecretResolver({ fallback: "" })
})

runtime.register([XEngagementWorkflow])

export const client = createWorkflowClient(runtime)
export { XEngagementWorkflow }
