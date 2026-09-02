import { describe, expect, test } from "bun:test"
import { loadWorkflowArtifact } from "../src/sdk/loader.ts"
import { parseWorkflowId } from "../src/sdk/catalog.ts"

const source = (message: string): string => `
import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const emit = defineStep({
  name: "Emit",
  input: t.void,
  output: t.string,
  execute: async () => ${JSON.stringify(message)}
})

export const LoaderHashWorkflow = defineWorkflow({
  name: "LoaderHashWorkflow",
  input: t.void,
  output: t.string,
  run: function* (_input, ctx) {
    return yield* ctx.run(emit, undefined)
  }
})
`

describe("workflow artifact loader", () => {
  test("hashes the complete stored source", async () => {
    const firstArtifact = {
      id: parseWorkflowId("loader-hash-a"),
      source: source("first")
    }
    const secondArtifact = {
      ...firstArtifact,
      id: parseWorkflowId("loader-hash-b"),
      source: source("second")
    }

    const first = await loadWorkflowArtifact(firstArtifact)
    const same = await loadWorkflowArtifact(firstArtifact)
    const second = await loadWorkflowArtifact(secondArtifact)

    expect(first.workflow.sourceHash).toBe(same.workflow.sourceHash)
    expect(first.workflow.sourceHash).not.toBe(second.workflow.sourceHash)
  })

  test("loads a large workflow source", async () => {
    const artifact = {
      id: parseWorkflowId("loader-large-source"),
      source: `${source("large")}\n/* ${"x".repeat(100_000)} */`
    }

    const loaded = await loadWorkflowArtifact(artifact)

    expect(loaded.workflow.name).toBe("LoaderHashWorkflow")
  })

})
