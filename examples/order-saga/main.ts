// Runs the order saga against the in-process mock API on a durable sqlite
// backend and validates the recorded history: event counts, compensation
// order, retry behavior, and the mock services' final state.

import { rmSync } from "node:fs"
import path from "node:path"
import { createWorkflowClient, createWorkflowRuntime } from "wf"
import type { WorkflowHistoryRecord } from "wf"
import { startMockApi } from "./mock-api"
import { OrderWorkflow } from "./order"

const databasePath = path.join(import.meta.dir, ".wf", "order-saga.sqlite")
rmSync(path.dirname(databasePath), { recursive: true, force: true })

const api = startMockApi({ initialStock: { "sku-widget": 10 } })
const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath })
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}${ok || detail === "" ? "" : ` — ${detail}`}`)
  if (!ok) {
    failures++
  }
}

const eventTypes = (history: ReadonlyArray<WorkflowHistoryRecord>) =>
  history.map((record) => record.event.type)

// The client API surfaces results/errors as unknown; narrow field access here
// at the boundary instead of casting.
const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  return undefined
}

const stringField = (value: unknown, key: string): string | undefined => {
  const entry = asRecord(value)?.[key]
  return typeof entry === "string" ? entry : undefined
}

const numberField = (value: unknown, key: string): number | undefined => {
  const entry = asRecord(value)?.[key]
  return typeof entry === "number" ? entry : undefined
}

const countBy = (history: ReadonlyArray<WorkflowHistoryRecord>, predicate: (event: WorkflowHistoryRecord["event"]) => boolean) =>
  history.filter((record) => predicate(record.event)).length

const stepEvents = (
  history: ReadonlyArray<WorkflowHistoryRecord>,
  type: string,
  stepName: string
) =>
  countBy(history, (event) =>
    event.type === type && "stepName" in event && event.stepName === stepName
  )

const firstIndex = (history: ReadonlyArray<WorkflowHistoryRecord>, predicate: (event: WorkflowHistoryRecord["event"]) => boolean) =>
  history.findIndex((record) => predicate(record.event))

const runScenario = async (input: {
  orderId: string
  quantity: number
  address: string
}) => {
  const handle = await client.start(OrderWorkflow, {
    apiUrl: api.url,
    orderId: input.orderId,
    sku: "sku-widget",
    quantity: input.quantity,
    unitPriceCents: 250,
    address: input.address
  })
  const result = await client.result(handle.executionId)
  const history = await client.history(handle.executionId)
  const status = await client.status(handle.executionId)
  return { handle, result, history, status }
}

// --- Scenario 1: happy path (charge retries once, then succeeds) -----------

console.log("\nScenario 1: happy path")
{
  const { result, history, status } = await runScenario({
    orderId: "order-1",
    quantity: 2,
    address: "42 Sunny Lane"
  })

  check("workflow completed", result.type === "completed", JSON.stringify(result))
  check("status is completed", status === "completed", status)
  if (result.type === "completed") {
    check("total computed via ctx.code", numberField(result.value, "totalCents") === 500, JSON.stringify(result.value))
    check("tracking id returned", (stringField(result.value, "trackingId") ?? "").length > 0)
  }

  check("exactly 1 execution.started", countBy(history, (e) => e.type === "execution.started") === 1)
  check("exactly 1 workflow.started", countBy(history, (e) => e.type === "workflow.started") === 1)
  check("exactly 1 workflow.completed", countBy(history, (e) => e.type === "workflow.completed") === 1)
  check("code block started+completed once each",
    countBy(history, (e) => e.type === "code.started") === 1 &&
    countBy(history, (e) => e.type === "code.completed") === 1)
  check("ReserveInventory: 1 started, 1 completed, 0 failed",
    stepEvents(history, "step.started", "ReserveInventory") === 1 &&
    stepEvents(history, "step.completed", "ReserveInventory") === 1 &&
    stepEvents(history, "step.failed", "ReserveInventory") === 0)
  check("ChargePayment retried: 2 started, 1 failed, 1 completed",
    stepEvents(history, "step.started", "ChargePayment") === 2 &&
    stepEvents(history, "step.failed", "ChargePayment") === 1 &&
    stepEvents(history, "step.completed", "ChargePayment") === 1,
    `started=${stepEvents(history, "step.started", "ChargePayment")} failed=${stepEvents(history, "step.failed", "ChargePayment")} completed=${stepEvents(history, "step.completed", "ChargePayment")}`)
  check("sleep started+completed once each",
    countBy(history, (e) => e.type === "sleep.started") === 1 &&
    countBy(history, (e) => e.type === "sleep.completed") === 1,
    `started=${countBy(history, (e) => e.type === "sleep.started")} completed=${countBy(history, (e) => e.type === "sleep.completed")}`)
  check("no compensation events", countBy(history, (e) => e.type.startsWith("compensation.")) === 0)

  const snapshot = api.snapshot()
  check("reservation still held", snapshot.reservations.some((r) => r.orderId === "order-1" && r.status === "reserved"))
  check("charge captured", snapshot.charges.some((c) => c.orderId === "order-1" && c.status === "charged"))
  check("shipment dispatched", snapshot.shipments.some((s) => s.orderId === "order-1"))
}

// --- Scenario 2: dispatch fails terminally, saga compensates ---------------

console.log("\nScenario 2: undeliverable address triggers compensation")
{
  const { result, history, status } = await runScenario({
    orderId: "order-2",
    quantity: 1,
    address: "1 Nowhere Street"
  })

  check("workflow failed", result.type === "failed", JSON.stringify(result))
  check("status is failed", status === "failed", status)
  if (result.type === "failed") {
    check("error is UndeliverableAddressError", stringField(result.error, "_tag") === "UndeliverableAddressError", JSON.stringify(result.error))
  }

  check("DispatchShipment failed terminally without retries",
    stepEvents(history, "step.started", "DispatchShipment") === 1 &&
    stepEvents(history, "step.failed", "DispatchShipment") === 1,
    `started=${stepEvents(history, "step.started", "DispatchShipment")}`)
  check("both completed steps compensated",
    countBy(history, (e) => e.type === "compensation.started") === 2 &&
    countBy(history, (e) => e.type === "compensation.completed") === 2,
    eventTypes(history).filter((t) => t.startsWith("compensation.")).join(","))

  const chargeCompensation = firstIndex(history, (e) =>
    e.type === "compensation.started" && "stepName" in e && e.stepName === "ChargePayment")
  const reserveCompensation = firstIndex(history, (e) =>
    e.type === "compensation.started" && "stepName" in e && e.stepName === "ReserveInventory")
  check("compensation runs in reverse order (refund before release)",
    chargeCompensation !== -1 && reserveCompensation !== -1 && chargeCompensation < reserveCompensation,
    `charge@${chargeCompensation} reserve@${reserveCompensation}`)
  check("exactly 1 workflow.failed", countBy(history, (e) => e.type === "workflow.failed") === 1)

  const snapshot = api.snapshot()
  check("charge refunded", snapshot.charges.some((c) => c.orderId === "order-2" && c.status === "refunded"))
  check("reservation released", snapshot.reservations.some((r) => r.orderId === "order-2" && r.status === "released"))
  check("stock restored", snapshot.stock["sku-widget"] === 8, String(snapshot.stock["sku-widget"]))
  check("no shipment created", !snapshot.shipments.some((s) => s.orderId === "order-2"))
}

// --- Scenario 3: out of stock fails the first step, nothing to compensate --

console.log("\nScenario 3: out of stock fails fast")
{
  const { result, history } = await runScenario({
    orderId: "order-3",
    quantity: 999,
    address: "42 Sunny Lane"
  })

  check("workflow failed", result.type === "failed", JSON.stringify(result))
  if (result.type === "failed") {
    check("error is OutOfStockError with availability",
      stringField(result.error, "_tag") === "OutOfStockError" && numberField(result.error, "available") === 8,
      JSON.stringify(result.error))
  }
  check("terminal error skips retries (1 started, 1 failed)",
    stepEvents(history, "step.started", "ReserveInventory") === 1 &&
    stepEvents(history, "step.failed", "ReserveInventory") === 1)
  check("no compensation events", countBy(history, (e) => e.type.startsWith("compensation.")) === 0)
  check("payment never attempted", stepEvents(history, "step.started", "ChargePayment") === 0)
}

console.log(`\n${failures === 0 ? "All order-saga checks passed." : `${failures} order-saga check(s) FAILED.`}`)
api.stop()
process.exit(failures === 0 ? 0 : 1)
