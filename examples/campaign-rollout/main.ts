import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { CampaignRolloutWorkflow } from "./workflow"

const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: ".wf/campaign-rollout.sqlite" })
runtime.register([CampaignRolloutWorkflow])
const client = createWorkflowClient(runtime)

try {
  const handle = await client.start(CampaignRolloutWorkflow, {
    campaignId: "spring-release",
    audiences: [
      { name: "early-access", recipients: 120 },
      { name: "general", recipients: 850 }
    ]
  })
  console.log(`started execution ${handle.executionId}`)

  const observation = await client.observe(handle.executionId)
  if (observation.type === "signal-suspended") {
    await client.signal(handle.executionId, "rolloutApproval", {
      approved: true,
      reviewer: "demo-reviewer"
    }, { actor: "demo-reviewer" })
  }

  console.log("result:", await client.result(handle.executionId))
  console.log(`${(await client.history(handle.executionId)).length} history events recorded`)
} finally {
  await client.dispose()
}
