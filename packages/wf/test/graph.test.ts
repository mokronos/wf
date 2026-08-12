import { describe, expect, test } from "bun:test"
import {
  defineStep,
  defineWorkflow,
  integration,
  t,
  workflowGraphIntegrationAddresses,
  workflowToGraph
} from "../src/index"

const approve = defineStep({
  name: "Approve",
  input: t.struct({ id: t.string }),
  output: t.struct({ approvalId: t.string }),
  retry: { attempts: 2, backoff: "none" },
  execute: async () => ({ approvalId: "real" })
})

const publish = defineStep({
  name: "Publish",
  input: t.struct({ approvalId: t.string }),
  output: t.void,
  execute: async () => undefined
})

const DemoWorkflow = defineWorkflow({
  name: "DemoWorkflow",
  input: t.struct({ id: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    const result = yield* ctx.run(approve, input)
    yield* ctx.sleep("1 second", "review-window")
    yield* ctx.waitForSignal("release", t.struct({ ok: t.boolean }))
    yield* ctx.run(publish, result)
  }
})

const CodeWorkflow = defineWorkflow({
  name: "CodeWorkflow",
  input: t.struct({ email: t.string }),
  output: t.struct({ subject: t.string }),
  run: function* (input, ctx) {
    const subject = yield* ctx.code("build-subject", {
      output: t.string,
      reason: "Derive a friendly subject from the recipient's email local part",
      run: () => `Welcome, ${input.email.split("@")[0]}!`
    })
    return { subject }
  }
})

const charge = defineStep({
  name: "Charge",
  input: t.struct({ id: t.string }),
  output: t.struct({ paymentId: t.string }),
  execute: async () => ({ paymentId: "payment" })
})

const reserve = defineStep({
  name: "Reserve",
  input: t.struct({ id: t.string }),
  output: t.struct({ reservationId: t.string }),
  execute: async () => ({ reservationId: "reservation" })
})

const notify = defineStep({
  name: "Notify",
  input: t.struct({ paymentId: t.string, reservationId: t.string }),
  output: t.void,
  execute: async () => undefined
})

const ParallelWorkflow = defineWorkflow({
  name: "ParallelWorkflow",
  input: t.struct({ id: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    const [payment, inventory] = yield* ctx.all([
      ctx.run(charge, input),
      ctx.run(reserve, input)
    ], { name: "parallel" })
    yield* ctx.run(notify, {
      paymentId: payment.paymentId,
      reservationId: inventory.reservationId
    })
  }
})

describe("workflowToGraph", () => {
  test("does not run real void steps when the tracer returns undefined", async () => {
    let executions = 0
    const sideEffect = defineStep({
      name: "voidSideEffect",
      input: t.void,
      output: t.void,
      execute: async () => {
        executions++
      }
    })
    const workflow = defineWorkflow({
      name: "voidGraphWorkflow",
      input: t.void,
      output: t.void,
      run: function* (_input, ctx) {
        yield* ctx.run(sideEffect, undefined)
      }
    })

    await workflowToGraph(workflow)

    expect(executions).toBe(0)
  })

  test("traces workflow primitives without running real steps", async () => {
    const graph = await workflowToGraph(DemoWorkflow, { input: { id: "demo" } })

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "start",
      "step",
      "sleep",
      "signal",
      "step",
      "end"
    ])
    expect(graph.edges).toHaveLength(5)
    expect(graph.nodes.find((node) => node.label === "Approve")?.metadata.retry).toEqual({
      attempts: 2,
      backoff: "none"
    })
    expect(graph.schemas?.input).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"]
    })
    expect(graph.schemas?.output).toMatchObject({
      type: "null"
    })
    expect(graph.nodes.find((node) => node.label === "Approve")?.schemas?.input).toMatchObject({
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"]
    })
    expect(graph.nodes.find((node) => node.label === "Approve")?.schemas?.output).toMatchObject({
      type: "object",
      properties: {
        approvalId: { type: "string" }
      },
      required: ["approvalId"]
    })
    expect(graph.diagnostics).toEqual([])
  })

  test("traces code sections with reason metadata", async () => {
    const graph = await workflowToGraph(CodeWorkflow, { input: { email: "ada@example.com" } })
    const node = graph.nodes.find((candidate) => candidate.kind === "code")

    expect(node).toMatchObject({
      kind: "code",
      label: "build-subject",
      description: "Derive a friendly subject from the recipient's email local part",
      metadata: {
        activityName: "build-subject#1",
        reason: "Derive a friendly subject from the recipient's email local part"
      }
    })
    expect(graph.diagnostics).toEqual([])
  })

  test("renders the durable date codec as one JSON string schema", async () => {
    const workflow = defineWorkflow({
      name: "DateGraphWorkflow",
      input: t.struct({}),
      output: t.struct({ capturedAt: t.date }),
      run: function* (_input, ctx) {
        return { capturedAt: yield* ctx.now() }
      }
    })

    const graph = await workflowToGraph(workflow, { input: {} })

    expect(graph.schemas?.output).toMatchObject({
      properties: { capturedAt: { type: "string" } }
    })
    expect(graph.schemas?.output?.properties?.["capturedAt"]?.anyOf).toBeUndefined()
  })

  test("renders ctx.all as a fork with branch fan-in", async () => {
    const graph = await workflowToGraph(ParallelWorkflow, { input: { id: "demo" } })

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "start",
      "all",
      "step",
      "step",
      "step",
      "end"
    ])
    expect(graph.nodes.find((node) => node.kind === "all")).toMatchObject({
      label: "parallel",
      metadata: { branches: 2 }
    })
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "start", target: "all:parallel:1" }),
        expect.objectContaining({ source: "all:parallel:1", target: "step:Charge:1", label: "branch 1" }),
        expect.objectContaining({ source: "all:parallel:1", target: "step:Reserve:1", label: "branch 2" }),
        expect.objectContaining({ source: "step:Charge:1", target: "step:Notify:1" }),
        expect.objectContaining({ source: "step:Reserve:1", target: "step:Notify:1" }),
        expect.objectContaining({ source: "step:Notify:1", target: "end" })
      ])
    )
    expect(graph.calls).toEqual([
      { kind: "all", name: "parallel", counter: 1, branches: 2 },
      { kind: "step", name: "Charge", counter: 1 },
      { kind: "step", name: "Reserve", counter: 1 },
      { kind: "step", name: "Notify", counter: 1 }
    ])
    expect(graph.diagnostics).toEqual([])
  })

  test("exposes distinct integration addresses without invoking them", async () => {
    const first = integration({
      source: { kind: "executor", address: "tools.docs.org.default.lookup" },
      input: t.struct({ query: t.string }),
      output: t.string
    })
    const duplicate = integration({
      source: { kind: "executor", address: "tools.docs.org.default.lookup" },
      input: t.struct({ query: t.string }),
      output: t.string
    })
    const second = integration({
      source: { kind: "executor", address: "tools.catalog.org.default.list" },
      input: t.struct({}),
      output: t.unknown
    })
    const workflow = defineWorkflow({
      name: "IntegrationGraphWorkflow",
      input: t.struct({ query: t.string }),
      output: t.void,
      run: function* (input, ctx) {
        yield* ctx.run(first, input)
        yield* ctx.run(duplicate, input)
        yield* ctx.run(second, {})
      }
    })

    const graph = await workflowToGraph(workflow, { input: { query: "durability" } })

    expect(workflowGraphIntegrationAddresses(graph)).toEqual([
      "tools.docs.org.default.lookup",
      "tools.catalog.org.default.list"
    ])
    expect(graph.nodes.find((node) => node.label.includes("tools.docs"))?.metadata.integration).toEqual({
      address: "tools.docs.org.default.lookup"
    })
  })
})
