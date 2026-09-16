import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { cliLayer, cliWorkspace, runCli } from "./run-cli.ts"

/** Each test gets its own in-repo directory, used as both cwd and WF_HOME. */
const workspace = Effect.gen(function* () {
  const home = yield* cliWorkspace
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  return {
    home,
    run: (args: ReadonlyArray<string>) => runCli(args, { cwd: home, home }),
    write: Effect.fnUntraced(function* (name: string, source: string) {
      const file = path.join(home, name)
      yield* fs.writeFileString(file, source)
      return file
    })
  } as const
})

const workflowSource = (id: number): string => `import { defineWorkflow, t } from "@mokronos/wfkit"
export const Workflow${id} = defineWorkflow({
  name: "Workflow${id}",
  input: t.struct({}),
  output: t.number,
  run: function* () { return ${id} }
})
`

const loggingWorkflowSource = `import { defineWorkflow, t } from "@mokronos/wfkit"
console.log("module-noise")
export const LoggingWorkflow = defineWorkflow({
  name: "LoggingWorkflow",
  input: t.struct({}),
  output: t.number,
  run: function* () {
    console.log("run-noise")
    return 1
  }
})
`

const jsonLoggingWorkflowSource = `import { defineWorkflow, t } from "@mokronos/wfkit"
console.log("json-module-noise")
export const JsonLoggingWorkflow = defineWorkflow({
  name: "JsonLoggingWorkflow",
  input: t.struct({}),
  output: t.number,
  run: function* () { return 1 }
})
`

describe("progressive CLI output", () => {
  it.effect("workflow listings are bounded unless verbose", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      for (let index = 0; index < 22; index++) {
        const id = `workflow-${String(index).padStart(2, "0")}`
        const created = yield* wf.run(["create", id, "--source", workflowSource(index)])
        expect(created.exitCode, created.stderr).toBe(0)
      }

      const listed = yield* wf.run(["list"])
      expect(listed.exitCode, listed.stderr).toBe(0)
      expect(listed.stdout.trim().split("\n")).toHaveLength(11)
      expect(listed.stdout).toContain("Showing 10 of 22")
      expect(listed.stdout).not.toContain("bytes")

      const verbose = yield* wf.run(["list", "--verbose"])
      expect(verbose.exitCode, verbose.stderr).toBe(0)
      expect(verbose.stdout.trim().split("\n")).toHaveLength(22)
      expect(verbose.stdout).toContain("bytes")
      expect(verbose.stdout).not.toContain("Showing 10 of 22")
    }).pipe(Effect.provide(cliLayer)), 30_000)

  it.effect("history defaults to recent event identities", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const created = yield* wf.run(["create", "history-demo", "--source", workflowSource(1)])
      expect(created.exitCode, created.stderr).toBe(0)
      const run = yield* wf.run(["run", "history-demo"])
      expect(run.exitCode, run.stderr).toBe(0)
      const runId = run.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
      expect(runId).toBeDefined()

      const history = yield* wf.run(["history", runId!])
      expect(history.exitCode, history.stderr).toBe(0)
      expect(history.stdout).toContain("workflow.completed")
      expect(history.stdout).not.toContain('"result"')

      const verbose = yield* wf.run(["history", runId!, "--verbose"])
      expect(verbose.exitCode, verbose.stderr).toBe(0)
      expect(verbose.stdout).toContain('"result"')
    }).pipe(Effect.provide(cliLayer)), 30_000)

  it.effect("workflow logs are available only in verbose mode", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const created = yield* wf.run(["create", "logging-demo", "--source", loggingWorkflowSource])
      expect(created.exitCode, created.stderr).toBe(0)
      expect(created.stdout).not.toContain("module-noise")

      const concise = yield* wf.run(["run", "logging-demo"])
      expect(concise.exitCode, concise.stderr).toBe(0)
      expect(concise.stdout).toBe("1\n")
      expect(concise.stdout).not.toContain("noise")

      const verbose = yield* wf.run(["run", "logging-demo", "--verbose"])
      expect(verbose.exitCode, verbose.stderr).toBe(0)
      expect(verbose.stdout).toBe("1\n")
      expect(verbose.stderr).toContain("module-noise")
      expect(verbose.stderr).toContain("run-noise")
    }).pipe(Effect.provide(cliLayer)), 30_000)

  it.effect("verbose JSON validation keeps stdout parseable", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const file = yield* wf.write("json-logging.ts", jsonLoggingWorkflowSource)

      const validated = yield* wf.run(["validate", "--file", file, "--json", "--verbose"])
      expect(validated.exitCode, validated.stderr).toBe(0)
      expect(() => JSON.parse(validated.stdout)).not.toThrow()
      expect(validated.stderr).toContain("json-module-noise")
    }).pipe(Effect.provide(cliLayer)))
})
