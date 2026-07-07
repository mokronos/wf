import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  createInMemoryDeterminismState,
  defineStep,
  defineWorkflow,
  NonDeterminismError
} from "../src/core"

class SimulatedCrash extends Error {
  readonly _tag = "SimulatedCrash"
}

describe("Phase 2 determinism", () => {
  test("ctx.now and ctx.random replay identical values across crash and resume", async () => {
    const determinism = createInMemoryDeterminismState()
    const executionId = "phase2-resume"
    const observedBeforeCrash: Array<{ readonly now: Date; readonly random: number }> = []

    const before = defineStep({
      name: "before",
      input: Schema.Void,
      output: Schema.Void,
      execute: async () => undefined
    })

    const crashWorkflow = defineWorkflow({
      name: "deterministicValues",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(before, undefined)
        const now = yield* ctx.now()
        const random = yield* ctx.random()
        observedBeforeCrash.push({ now, random })
        yield* ctx.effect(Effect.fail(new SimulatedCrash("simulated crash between steps")))
      }
    })

    await expect(
      crashWorkflow.executeInMemory(undefined, { executionId, determinism })
    ).rejects.toThrow("simulated crash")
    expect(observedBeforeCrash).toHaveLength(1)

    const resumeWorkflow = defineWorkflow({
      name: "deterministicValues",
      version: 1,
      input: Schema.Void,
      output: Schema.Struct({
        nowMs: Schema.Number,
        random: Schema.Number
      }),
      run: function* (_, ctx) {
        yield* ctx.run(before, undefined)
        const now = yield* ctx.now()
        const random = yield* ctx.random()
        return { nowMs: now.getTime(), random }
      }
    })

    await expect(
      resumeWorkflow.executeInMemory(undefined, { executionId, determinism })
    ).resolves.toEqual({
      nowMs: observedBeforeCrash[0]!.now.getTime(),
      random: observedBeforeCrash[0]!.random
    })
  })

  test("replay divergence fails before executing the mismatched step", async () => {
    const determinism = createInMemoryDeterminismState()
    const executionId = "phase2-divergence"
    const writes: string[] = []

    const first = defineStep({
      name: "first",
      input: Schema.Void,
      output: Schema.Void,
      execute: async () => {
        writes.push("first")
      }
    })

    const second = defineStep({
      name: "second",
      input: Schema.Void,
      output: Schema.Void,
      execute: async () => {
        writes.push("second")
      }
    })

    const original = defineWorkflow({
      name: "divergentWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(first, undefined)
      }
    })

    await original.executeInMemory(undefined, { executionId, determinism })
    expect(writes).toEqual(["first"])

    writes.length = 0
    const divergent = defineWorkflow({
      name: "divergentWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(second, undefined)
      }
    })

    await expect(divergent.executeInMemory(undefined, { executionId, determinism })).rejects.toThrow(
      NonDeterminismError
    )
    await expect(divergent.executeInMemory(undefined, { executionId, determinism })).rejects.toThrow(
      "expected step:first#1 but saw step:second#1"
    )
    expect(writes).toEqual([])
  })

  test("ctx.code records a journal entry and detects replay divergence", async () => {
    const determinism = createInMemoryDeterminismState()
    const executionId = "phase2-code-divergence"
    const writes: string[] = []

    const mismatched = defineStep({
      name: "mismatched",
      input: Schema.Void,
      output: Schema.Void,
      execute: async () => {
        writes.push("mismatched")
      }
    })

    const original = defineWorkflow({
      name: "codeDivergentWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.String,
      run: function* (_, ctx) {
        return yield* ctx.code("build-value", {
          reason: "Build a replayed value",
          run: () => "recorded"
        })
      }
    })

    await expect(original.executeInMemory(undefined, { executionId, determinism })).resolves.toBe("recorded")
    expect(determinism.calls).toEqual([{ kind: "code", name: "build-value", counter: 1 }])

    const divergent = defineWorkflow({
      name: "codeDivergentWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Void,
      run: function* (_, ctx) {
        yield* ctx.run(mismatched, undefined)
      }
    })

    await expect(divergent.executeInMemory(undefined, { executionId, determinism })).rejects.toThrow(
      NonDeterminismError
    )
    await expect(divergent.executeInMemory(undefined, { executionId, determinism })).rejects.toThrow(
      "expected code:build-value#1 but saw step:mismatched#1"
    )
    expect(writes).toEqual([])
  })

  test("ctx.code reuses stored in-memory values with shared determinism state", async () => {
    const determinism = createInMemoryDeterminismState()
    const executionId = "phase2-code-reuse"
    let invocations = 0

    const workflow = defineWorkflow({
      name: "codeReuseWorkflow",
      version: 1,
      input: Schema.Void,
      output: Schema.Number,
      run: function* (_, ctx) {
        return yield* ctx.code("stable-value", {
          reason: "Produce a value once and replay it later",
          run: () => ++invocations
        })
      }
    })

    await expect(workflow.executeInMemory(undefined, { executionId, determinism })).resolves.toBe(1)
    await expect(workflow.executeInMemory(undefined, { executionId, determinism })).resolves.toBe(1)
    expect(invocations).toBe(1)
  })
})
