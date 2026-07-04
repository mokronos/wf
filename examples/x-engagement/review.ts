import { client } from "./runtime"

const [executionId, action, text] = process.argv.slice(2)

if (executionId === undefined || action === undefined) {
  console.error("usage: bun run examples/x-engagement/review.ts <executionId> accept|decline|edit \"text\"|feedback \"note\"")
  process.exit(1)
}

const waiting = (await client.pendingSignals(executionId))
  .filter((signal) => signal.name.startsWith("reviewDecision:"))
  .at(-1)

if (waiting === undefined) {
  throw new Error(`Execution ${executionId} is not waiting for a reviewDecision signal`)
}

const payload = (() => {
  switch (action) {
    case "accept":
      return { _tag: "accept" }
    case "decline":
      return { _tag: "decline" }
    case "edit":
      if (text === undefined) throw new Error("edit requires replacement text")
      return { _tag: "edit", text }
    case "feedback":
      if (text === undefined) throw new Error("feedback requires a note")
      return { _tag: "feedback", note: text }
    default:
      throw new Error(`Unknown review action: ${action}`)
  }
})()

await client.signal(executionId, waiting.name, payload, { actor: "shell-reviewer" })
console.log(`sent ${action} to ${waiting.name}`)

// A feedback decision re-drafts and suspends for the next review round (the
// new draft prints above via notifyReviewer, since the resume replays in this
// process), so waiting for the final result would hang. Wait for whichever
// comes first: a terminal result, or a new review suspension.
const suspendedAgain = async () => {
  while (true) {
    if ((await client.pendingSignals(executionId)).some((signal) => signal.name.startsWith("reviewDecision:"))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
const outcome = await Promise.race([
  client.result(executionId).then((result) => ({ type: "done" as const, result })),
  suspendedAgain().then(() => ({ type: "suspended" as const }))
])
if (outcome.type === "suspended") {
  console.log("workflow suspended for the next review round (see the new draft above)")
} else {
  console.log("result:", outcome.result)
}

process.exit(0)
