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
  test("hashes the complete stored source, including step and integration definitions", async () => {
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
})
