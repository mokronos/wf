import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { OrderWorkflow } from "./order"

// The runtime persists engine state (activity results, timers, suspended
// signal waits) in SQLite, so executions survive process restarts.
const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: ".wf/quickstart.sqlite" })
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

try {
  const handle = await client.start(OrderWorkflow, { orderId: "123", amount: 42 })
  console.log(`started execution ${handle.executionId}`)

  // The client owns observation: callers only describe what happens once the
  // workflow reaches a meaningful lifecycle state.
  const observation = await client.observe(handle.executionId)
  if (observation.type === "signal-suspended") {
    await client.signal(handle.executionId, "managerApproval", { approved: true }, { actor: "manager" })
  }

  console.log("result:", await client.result(handle.executionId))
  console.log(`${(await client.history(handle.executionId)).length} history events recorded`)
} finally {
  await client.dispose()
}
