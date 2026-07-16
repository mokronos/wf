// Human-in-the-loop expense approval on the durable sqlite backend.
//
//   bun run main.ts demo             — scripted scenarios with validation
//   bun run main.ts start [amount]   — start a run, exit while it is suspended
//   bun run main.ts pending <id>     — show what the run is waiting for
//   bun run main.ts approve <id>     — resume a suspended run with approval
//   bun run main.ts reject <id>      — resume a suspended run with rejection
//   bun run main.ts status <id>      — print status
//
// start/approve run in separate processes, so together they demonstrate
// pause -> process exit -> resume from the persisted state.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import type { WorkflowClient, WorkflowHistoryRecord } from "@mokronos/wfkit"
import { ExpenseApprovalWorkflow } from "./approval"

const makeClient = (databasePath: string): WorkflowClient => {
  const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath })
  runtime.register([ExpenseApprovalWorkflow])
  return createWorkflowClient(runtime)
}

const waitForStatus = async (client: WorkflowClient, executionId: string, expected: string) => {
  for (let index = 0; index < 300; index++) {
    const status = await client.status(executionId)
    if (status === expected) {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return client.status(executionId)
}

const waitForHistoryEvent = async (
  client: WorkflowClient,
  executionId: string,
  type: string,
  minimum = 1
) => {
  for (let index = 0; index < 300; index++) {
    const history = await client.history(executionId)
    if (history.filter((record) => record.event.type === type).length >= minimum) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for history event ${type} (x${minimum})`)
}

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`)
  if (!ok) {
    failures++
  }
}

const countBy = (
  history: ReadonlyArray<WorkflowHistoryRecord>,
  predicate: (event: WorkflowHistoryRecord["event"]) => boolean
) => history.filter((record) => predicate(record.event)).length

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entry = Object.fromEntries(Object.entries(value))[key]
    return typeof entry === "string" ? entry : undefined
  }
  return undefined
}

const demo = async () => {
  const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "wf-approval-demo-")), "approval.sqlite")
  const client = makeClient(databasePath)

  console.log("\nScenario 1: approved by a human")
  {
    const handle = await client.start(
      ExpenseApprovalWorkflow,
      { requestId: "exp-1", requester: "sam", amountCents: 4200 },
      { actor: "sam" }
    )
    check("run suspends waiting for a human", await waitForStatus(client, handle.executionId, "suspended") === "suspended")

    const pending = await client.pendingSignals(handle.executionId)
    check("pendingSignals names the approval signal",
      pending.length === 1 && pending[0]?.name === "approval",
      JSON.stringify(pending))

    await client.signal(handle.executionId, "approval", { approved: true, approver: "kim", comment: "lgtm" }, { actor: "kim" })
    const result = await client.result(handle.executionId)
    check("workflow completed after approval", result.type === "completed", JSON.stringify(result))
    if (result.type === "completed") {
      check("output names the approver", stringField(result.value, "approver") === "kim", JSON.stringify(result.value))
    }

    const history = await client.history(handle.executionId)
    check("exactly 1 signal.waiting", countBy(history, (e) => e.type === "signal.waiting") === 1,
      String(countBy(history, (e) => e.type === "signal.waiting")))
    check("exactly 1 signal.delivered (actor recorded)",
      countBy(history, (e) => e.type === "signal.delivered" && "actor" in e && e.actor === "kim") === 1)
    check("exactly 1 signal.received with payload",
      countBy(history, (e) => e.type === "signal.received" && "payload" in e && stringField(e.payload, "approver") === "kim") === 1)
    check("no timeout, no escalation, no compensation",
      countBy(history, (e) => e.type === "signal.timeout") === 0 &&
      countBy(history, (e) => e.type === "step.started" && "stepName" in e && e.stepName === "EscalateToManager") === 0 &&
      countBy(history, (e) => e.type.startsWith("compensation.")) === 0)
    check("pendingSignals is empty after completion", (await client.pendingSignals(handle.executionId)).length === 0)
  }

  console.log("\nScenario 2: rejected — budget hold is compensated")
  {
    const handle = await client.start(ExpenseApprovalWorkflow, {
      requestId: "exp-2",
      requester: "sam",
      amountCents: 99000
    })
    await waitForStatus(client, handle.executionId, "suspended")
    await client.signal(handle.executionId, "approval", { approved: false, approver: "kim", comment: "too much" })
    const result = await client.result(handle.executionId)
    check("workflow failed with typed rejection", result.type === "failed" && stringField(result.error, "_tag") === "ApprovalRejectedError",
      JSON.stringify(result))

    const history = await client.history(handle.executionId)
    check("ReserveBudget was compensated",
      countBy(history, (e) => e.type === "compensation.started" && "stepName" in e && e.stepName === "ReserveBudget") === 1 &&
      countBy(history, (e) => e.type === "compensation.completed") === 1,
      history.map((r) => r.event.type).join(","))
    check("ledger step never ran",
      countBy(history, (e) => e.type === "step.started" && "stepName" in e && e.stepName === "PostToLedger") === 0)
  }

  console.log("\nScenario 3: review times out, escalates, then approved")
  {
    const handle = await client.start(ExpenseApprovalWorkflow, {
      requestId: "exp-3",
      requester: "sam",
      amountCents: 1500,
      reviewTimeoutMillis: 300
    })
    await waitForHistoryEvent(client, handle.executionId, "signal.timeout")
    await waitForHistoryEvent(client, handle.executionId, "signal.waiting", 2)
    await client.signal(handle.executionId, "approval", { approved: true, approver: "manager" })
    const result = await client.result(handle.executionId)
    check("workflow completed after escalation", result.type === "completed", JSON.stringify(result))
    if (result.type === "completed") {
      check("manager approved", stringField(result.value, "approver") === "manager")
    }

    const history = await client.history(handle.executionId)
    check("one timeout, then escalation step ran",
      countBy(history, (e) => e.type === "signal.timeout") === 1 &&
      countBy(history, (e) => e.type === "step.completed" && "stepName" in e && e.stepName === "EscalateToManager") === 1)
    const waitingAt = history.find((r) => r.event.type === "signal.waiting")?.createdAt
    const timeoutAt = history.find((r) => r.event.type === "signal.timeout")?.createdAt
    const timeoutLatency = waitingAt === undefined || timeoutAt === undefined
      ? Number.NaN
      : Date.parse(timeoutAt) - Date.parse(waitingAt)
    check("300ms timeout fired within 3s (durable timer latency)",
      Number.isFinite(timeoutLatency) && timeoutLatency >= 250 && timeoutLatency < 3000,
      `${timeoutLatency}ms`)
    check("two signal waits recorded",
      countBy(history, (e) => e.type === "signal.waiting") === 2,
      String(countBy(history, (e) => e.type === "signal.waiting")))
  }

  console.log("\nScenario 4: cancelled while suspended — compensates and fails")
  {
    const handle = await client.start(ExpenseApprovalWorkflow, {
      requestId: "exp-4",
      requester: "sam",
      amountCents: 800
    })
    await waitForStatus(client, handle.executionId, "suspended")
    await client.cancel(handle.executionId, { compensate: true, actor: "ops" })
    check("status is failed after cancel", await waitForStatus(client, handle.executionId, "failed") === "failed")

    const history = await client.history(handle.executionId)
    check("execution.cancelled recorded with actor",
      countBy(history, (e) => e.type === "execution.cancelled" && "actor" in e && e.actor === "ops") === 1)
    check("cancellation reached the running execution",
      countBy(history, (e) => e.type === "cancellation.received") === 1,
      history.map((r) => r.event.type).join(","))
    check("budget hold compensated on cancel",
      countBy(history, (e) => e.type === "compensation.started" && "stepName" in e && e.stepName === "ReserveBudget") === 1 &&
      countBy(history, (e) => e.type === "compensation.completed") === 1)
  }

  console.log(`\n${failures === 0 ? "All approval checks passed." : `${failures} approval check(s) FAILED.`}`)
  rmSync(path.dirname(databasePath), { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

const persistentDbPath = path.join(import.meta.dir, ".wf", "approval.sqlite")

const main = async () => {
  const [command, argument] = process.argv.slice(2)

  switch (command) {
    case "demo":
      await demo()
      return

    case "start": {
      const client = makeClient(persistentDbPath)
      const amountCents = argument === undefined ? 5000 : Number.parseInt(argument, 10)
      const handle = await client.start(ExpenseApprovalWorkflow, {
        requestId: `exp-${Date.now()}`,
        requester: "cli",
        amountCents
      })
      const status = await waitForStatus(client, handle.executionId, "suspended")
      console.log(`execution ${handle.executionId} is ${status}; process exits now.`)
      console.log(`resume with: bun run main.ts approve ${handle.executionId}`)
      process.exit(0)
    }

    case "approve":
    case "reject": {
      if (argument === undefined) {
        throw new Error(`usage: bun run main.ts ${command} <execution-id>`)
      }
      const client = makeClient(persistentDbPath)
      await client.signal(argument, "approval", {
        approved: command === "approve",
        approver: "cli-human"
      }, { actor: "cli-human" })
      const result = await client.result(argument)
      console.log(JSON.stringify(result, null, 2))
      process.exit(0)
    }

    case "pending": {
      if (argument === undefined) {
        throw new Error("usage: bun run main.ts pending <execution-id>")
      }
      const client = makeClient(persistentDbPath)
      console.log(JSON.stringify(await client.pendingSignals(argument), null, 2))
      process.exit(0)
    }

    case "status": {
      if (argument === undefined) {
        throw new Error("usage: bun run main.ts status <execution-id>")
      }
      const client = makeClient(persistentDbPath)
      console.log(await client.status(argument))
      process.exit(0)
    }

    default:
      console.log("usage: bun run main.ts <demo|start|approve|reject|pending|status> [arg]")
      process.exit(command === undefined ? 0 : 1)
  }
}

await main()
