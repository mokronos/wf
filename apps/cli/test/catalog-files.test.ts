import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { cliLayer, cliWorkspace, runCli } from "./run-cli.ts"

/** Each test gets its own in-repo directory, used as both cwd and WF_HOME. */
const workspace = Effect.gen(function* () {
  const home = yield* cliWorkspace
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const workflowFile = (id: string) => path.join(home, "workflows", `${id}.ts`)
  return {
    home,
    workflowFile,
    run: (args: ReadonlyArray<string>) => runCli(args, { cwd: home, home }),
    readWorkflow: (id: string) => fs.readFileString(workflowFile(id)),
    // The kind of edit an agent makes with its own file tools.
    editWorkflow: (id: string, source: string) => fs.writeFileString(workflowFile(id), source),
    entries: fs.readDirectory(home)
  } as const
})

const workflowSource = (message: string) => `import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const printMessage = defineStep({
  name: "PrintMessage",
  input: t.struct({ message: t.string }),
  output: t.string,
  execute: async (input) => \`${message}:\${input.message}\`
})

export const FileDemoWorkflow = defineWorkflow({
  name: "FileDemoWorkflow",
  input: t.struct({ message: t.string }),
  output: t.string,
  run: function* (input, ctx) {
    return yield* ctx.run(printMessage, { message: input.message })
  }
})
`

const signalSource = (verdict: string) => `import { defineWorkflow, t } from "@mokronos/wfkit"

export const GateWorkflow = defineWorkflow({
  name: "GateWorkflow",
  input: t.struct({}),
  output: t.string,
  run: function* (_, ctx) {
    const signal = yield* ctx.waitForSignal("approval", t.struct({ approved: t.boolean }))
    return signal.type === "signal" && signal.value.approved ? "${verdict}" : "rejected"
  }
})
`

describe("file-backed workflow catalog", () => {
  it.effect("stores each workflow as an editable file under WF_HOME", () =>
    Effect.gen(function* () {
      const wf = yield* workspace

      const created = yield* wf.run(["create", "file-demo", "--source", workflowSource("first")])
      expect(created.exitCode, created.stderr).toBe(0)

      expect(created.stdout).toContain(wf.workflowFile("file-demo"))
      expect(yield* wf.readWorkflow("file-demo")).toBe(workflowSource("first"))

      const listed = yield* wf.run(["list"])
      expect(listed.exitCode, listed.stderr).toBe(0)
      const [id, updated, file] = listed.stdout.trim().split("\t")
      expect(id).toBe("file-demo")
      expect(updated).toMatch(/^updated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(file).toBe(wf.workflowFile("file-demo"))
      expect(listed.stdout).not.toContain("bytes")

      // No database is created for the catalog: the files are the catalog.
      expect(yield* wf.entries).not.toContain("wf.sqlite")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("runs a workflow that was edited on disk, with no CLI involved in the edit", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      expect((yield* wf.run(["create", "file-demo", "--source", workflowSource("first")])).exitCode).toBe(0)

      const first = yield* wf.run(["run", "file-demo", '{"message":"hello"}'])
      expect(first.exitCode, first.stderr).toBe(0)
      expect(first.stdout).toContain("first:hello")

      yield* wf.editWorkflow("file-demo", workflowSource("second"))

      const second = yield* wf.run(["run", "file-demo", '{"message":"hello"}'])
      expect(second.exitCode, second.stderr).toBe(0)
      expect(second.stdout).toContain("second:hello")
    }).pipe(Effect.provide(cliLayer)), 30_000)

  it.effect("rejects missing workflow input without creating a run", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      expect((yield* wf.run(["create", "file-demo", "--source", workflowSource("first")])).exitCode).toBe(0)

      const invalid = yield* wf.run(["run", "file-demo"])
      expect(invalid.exitCode).not.toBe(0)
      expect(invalid.stderr).toContain("Missing key")
      expect(invalid.stderr).not.toContain("[run] id")
      expect(invalid.stderr).not.toContain("[workflow] started")

      const runs = yield* wf.run(["runs"])
      expect(runs.exitCode, runs.stderr).toBe(0)
      expect(runs.stdout).toContain("No workflow runs found.")
    }).pipe(Effect.provide(cliLayer)), 30_000)

  it.effect("a workflow file with no workflow export is rejected without replacing the file", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      expect((yield* wf.run(["create", "file-demo", "--source", workflowSource("first")])).exitCode).toBe(0)

      const broken = yield* wf.run(["create", "file-demo", "--force", "--source", "export const nope = 1\n"])
      expect(broken.exitCode).not.toBe(0)
      expect(yield* wf.readWorkflow("file-demo")).toBe(workflowSource("first"))
    }).pipe(Effect.provide(cliLayer)))

  it.effect("resumes a suspended run against the source it started with, not the edited file", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      expect((yield* wf.run(["create", "gate", "--source", signalSource("approved-v1")])).exitCode).toBe(0)

      const started = yield* wf.run(["run", "gate", "{}"])
      expect(started.exitCode, started.stderr).toBe(0)
      expect(started.stderr).toContain("[signal] waiting for approval")
      const runId = started.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
      expect(runId).toBeDefined()

      // Edit while the run is parked on the signal.
      yield* wf.editWorkflow("gate", signalSource("approved-v2"))

      const signaled = yield* wf.run(["signal", runId!, "approval", '{"approved":true}'])
      expect(signaled.exitCode, signaled.stderr).toBe(0)
      expect(signaled.stdout).toContain("approved-v1")
      expect(signaled.stdout).not.toContain("approved-v2")

      // A new run picks up the edit.
      const afterEdit = yield* wf.run(["run", "gate", "{}"])
      const newRunId = afterEdit.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
      expect(newRunId).toBeDefined()
      const newSignaled = yield* wf.run(["signal", newRunId!, "approval", '{"approved":true}'])
      expect(newSignaled.exitCode, newSignaled.stderr).toBe(0)
      expect(newSignaled.stdout).toContain("approved-v2")
    }).pipe(Effect.provide(cliLayer)), 45_000)
})
