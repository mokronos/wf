import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "@effect/vitest"
import { defineWorkflow, executeWorkflow, t } from "../src/index.ts"

test("executeWorkflow passes the decoded payload to the workflow", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wf-standalone-"))
  const workflow = defineWorkflow({
    name: "StandalonePayloadWorkflow",
    input: t.struct({ id: t.string }),
    output: t.string,
    run: function* (input, ctx) {
      return yield* ctx.code("return-id", {
        output: t.string,
        run: () => input.id
      })
    }
  })

  try {
    await expect(executeWorkflow(workflow, { id: "expected" }, {
      engineDatabasePath: path.join(directory, "engine.sqlite")
    })).resolves.toBe("expected")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
