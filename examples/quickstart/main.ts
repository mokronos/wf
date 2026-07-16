import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { OrderWorkflow } from "./order"

// The runtime persists engine state (activity results, timers, suspended
// signal waits) in SQLite, so executions survive process restarts.
const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: ".wf/quickstart.sqlite" })
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

const handle = await client.start(OrderWorkflow, { orderId: "123", amount: 42 })
console.log(`started execution ${handle.executionId}`)

// Approve the order once the workflow suspends on the managerApproval signal.
const waitingForApproval = async () => {
  const history = await client.history(handle.executionId)
  return history.some((record) => record.event.type === "signal.waiting" && record.event.name === "managerApproval")
}
while (!(await waitingForApproval())) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
await client.signal(handle.executionId, "managerApproval", { approved: true }, { actor: "manager" })

const result = await client.result(handle.executionId)
console.log("result:", result)

const history = await client.history(handle.executionId)
console.log(`${history.length} history events recorded`)

// The engine's SQLite connection keeps the event loop alive.
process.exit(0)
