import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { cliLayer, cliWorkspace, runCli } from "./run-cli.ts"

const signalWorkflowSource = `import { defineWorkflow, t } from "@mokronos/wfkit"

export const SigDemoWorkflow = defineWorkflow({
  name: "SigDemoWorkflow",
  input: t.struct({}),
  output: t.string,
  run: function* (_, ctx) {
    const signal = yield* ctx.waitForSignal("approval", t.struct({ approved: t.boolean }))
    return signal.type === "signal" && signal.value.approved ? "approved" : "rejected"
  }
})
`

describe("wf signal", () => {
  it.effect("resumes a signal-suspended CLI run from another process", () =>
    Effect.gen(function* () {
      const cwd = yield* cliWorkspace
      const run = (args: ReadonlyArray<string>) => runCli(args, { cwd, home: cwd })

      const create = yield* run(["create", "sig-demo", "--source", signalWorkflowSource])
      expect(create.exitCode).toBe(0)

      const started = yield* run(["run", "sig-demo", "{}"])
      expect(started.exitCode).toBe(0)
      expect(started.stderr).toContain("[signal] waiting for approval")
      expect(started.stderr).toContain("wf signal")

      const runId = started.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
      expect(runId).toBeDefined()

      const signaled = yield* run(["signal", runId!, "approval", '{"approved":true}'])
      expect(signaled.exitCode).toBe(0)
      expect(signaled.stdout).toContain("approved")

      const runs = yield* run(["runs"])
      expect(runs.exitCode).toBe(0)
      expect(runs.stdout).toContain(`${runId}\tcompleted\tsig-demo`)

      const alreadyCompleted = yield* run(["signal", runId!, "approval", '{"approved":true}'])
      expect(alreadyCompleted.exitCode).not.toBe(0)
      expect(alreadyCompleted.stderr).toContain("not waiting for signal approval")
    }).pipe(Effect.provide(cliLayer)), 30_000)
})
