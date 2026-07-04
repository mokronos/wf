import { client, XEngagementWorkflow } from "./runtime"

const handle = await client.start(XEngagementWorkflow, {
  maxCandidates: Number(process.env.X_ENGAGEMENT_MAX_CANDIDATES ?? 1),
  dryRun: process.env.X_ENGAGEMENT_DRY_RUN !== "0"
})
console.log(`started execution ${handle.executionId}`)

const waitingForReview = async () => {
  const pending = await client.pendingSignals(handle.executionId)
  return pending.some((signal) => signal.name.startsWith("reviewDecision:"))
}
while (!(await waitingForReview())) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
console.log(`waiting for review; run bun run examples/x-engagement/review.ts ${handle.executionId} accept`)

process.exit(0)
