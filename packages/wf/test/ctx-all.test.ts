import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  createInMemoryDeterminismState,
  defineStep,
  defineWorkflow,
  NonDeterminismError
} from "../src/core"

const left = defineStep({
  name: "left",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.String,
  execute: async (input) => `left:${input.id}`
})

const right = defineStep({
  name: "right",
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.String,
  execute: async (input) => `right:${input.id}`
})

describe("ctx.all", () => {
  test("in-memory returns tuple results in order and records branch calls", async () => {
    const determinism = createInMemoryDeterminismState()
    const workflow = defineWorkflow({
      name: "allTupleWorkflow",
      version: 1,
      input: Schema.Struct({ id: Schema.String }),
      output: Schema.Tuple([Schema.String, Schema.String]),
      run: function* (input, ctx) {
        return yield* ctx.all([
          ctx.run(left, input),
          ctx.run(right, input)
        ], { name: "parallel" })
      }
    })

    await expect(workflow.executeInMemory({ id: "42" }, { determinism })).resolves.toEqual([
      "left:42",
      "right:42"
    ])
    expect(determinism.calls).toEqual([
      { kind: "all", name: "parallel", counter: 1, branches: 2 },
      { kind: "step", name: "left", counter: 1 },
      { kind: "step", name: "right", counter: 1 }
    ])
    expect(determinism.blocks).toEqual([
      {
        call: { kind: "all", name: "parallel", counter: 1, branches: 2 },
        branches: [
          [{ kind: "step", name: "left", counter: 1 }],
          [{ kind: "step", name: "right", counter: 1 }]
        ]
      }
    ])
  })

  test("in-memory replay reuses recorded branch values and rejects branch-count changes", async () => {
    const determinism = createInMemoryDeterminismState()
    let firstInvocations = 0
    let secondInvocations = 0

    const original = defineWorkflow({
      name: "allReplayWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Tuple([Schema.Number, Schema.Number]),
      run: function* (_, ctx) {
        return yield* ctx.all([
          ctx.code("first-value", { run: () => ++firstInvocations }),
          ctx.code("second-value", { run: () => ++secondInvocations })
        ], { name: "parallel" })
      }
    })

    await expect(original.executeInMemory(undefined, { determinism })).resolves.toEqual([1, 1])
    await expect(original.executeInMemory(undefined, { determinism })).resolves.toEqual([1, 1])
    expect(firstInvocations).toBe(1)
    expect(secondInvocations).toBe(1)

    const divergent = defineWorkflow({
      name: "allReplayWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Tuple([Schema.Number]),
      run: function* (_, ctx) {
        return yield* ctx.all([
          ctx.code("first-value", { run: () => ++firstInvocations })
        ], { name: "parallel" })
      }
    })

    await expect(divergent.executeInMemory(undefined, { determinism })).rejects.toThrow(
      NonDeterminismError
    )
    await expect(divergent.executeInMemory(undefined, { determinism })).rejects.toThrow(
      "expected all:parallel#1 branches=2 but saw all:parallel#1 branches=1"
    )
  })

  test("a failed branch fails ctx.all and compensates completed steps", async () => {
    const compensated: string[] = []
    const reserve = defineStep({
      name: "reserveForAll",
      input: Schema.String,
      output: Schema.String,
      execute: async (input) => `reserved:${input}`,
      compensate: async (result) => {
        compensated.push(result)
      }
    })
    const fail = defineStep({
      name: "failForAll",
      input: Schema.String,
      output: Schema.String,
      execute: async () => {
        throw new Error("branch failed")
      }
    })
    const workflow = defineWorkflow({
      name: "allFailureWorkflow",
      version: 1,
      input: Schema.String,
      output: Schema.Void,
      run: function* (input, ctx) {
        yield* ctx.all([
          ctx.run(reserve, input),
          ctx.run(fail, input)
        ], { name: "parallel" })
      }
    })

    await expect(workflow.executeInMemory("item")).rejects.toThrow("branch failed")
    expect(compensated).toEqual(["reserved:item"])
  })
})
