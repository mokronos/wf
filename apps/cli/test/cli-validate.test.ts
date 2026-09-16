import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { cliLayer, cliWorkspace, runCli } from "./run-cli.ts"

/** Each test gets its own in-repo directory, used as both cwd and WF_HOME. */
const workspace = Effect.gen(function* () {
  const cwd = yield* cliWorkspace
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  return {
    cwd,
    run: (args: ReadonlyArray<string>) => runCli(args, { cwd, home: cwd }),
    write: Effect.fnUntraced(function* (name: string, source: string) {
      const file = path.join(cwd, name)
      yield* fs.writeFileString(file, source)
      return file
    })
  } as const
})

const validWorkflowSource = `import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const printMessage = defineStep({
  name: "PrintMessage",
  input: t.struct({ message: t.string }),
  output: t.void,
  execute: async () => undefined
})

export const ValidateDemoWorkflow = defineWorkflow({
  name: "ValidateDemoWorkflow",
  input: t.struct({ message: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    yield* ctx.run(printMessage, { message: input.message })
  }
})
`

describe("wf validate", () => {
  it.effect("summarizes validation and reveals the traced flow with --verbose", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const create = yield* wf.run(["create", "validate-demo", "--source", validWorkflowSource])
      expect(create.exitCode, create.stderr).toBe(0)

      const result = yield* wf.run(["validate", "validate-demo"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Valid validate-demo")
      expect(result.stdout).toContain("ValidateDemoWorkflow")
      expect(result.stdout).toContain("1 orchestration call")
      expect(result.stdout).not.toContain("input:")
      expect(result.stdout).not.toContain("PrintMessage")

      const verbose = yield* wf.run(["validate", "validate-demo", "--verbose"])
      expect(verbose.stdout).toContain("input:")
      expect(verbose.stdout).toContain("flow:")
      expect(verbose.stdout).toContain("PrintMessage")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("validates an unregistered workflow file", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const file = yield* wf.write("Unregistered Workflow.ts", validWorkflowSource)

      const result = yield* wf.run(["validate", "--file", file])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Valid unregistered-workflow")
      expect(result.stdout).toContain("ValidateDemoWorkflow")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("reports module and export diagnostics", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const throwsAtModuleScope = yield* wf.write("throws.ts", 'throw new Error("module exploded")\n')
      const noWorkflowExport = yield* wf.write("no-workflow.ts", "export const value = 1\n")

      const thrown = yield* wf.run(["validate", "--file", throwsAtModuleScope])
      expect(thrown.exitCode).toBe(1)
      expect(thrown.stderr).toContain("Invalid throws")
      expect(thrown.stderr).toContain("module exploded")

      const missing = yield* wf.run(["validate", "--file", noWorkflowExport])
      expect(missing.exitCode).toBe(1)
      expect(missing.stderr).toContain("Invalid no-workflow")
      expect(missing.stderr).toContain("did not export a wf workflow")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("emits complete JSON for successful and failing validation", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const create = yield* wf.run(["create", "validate-demo", "--source", validWorkflowSource])
      expect(create.exitCode, create.stderr).toBe(0)

      const success = yield* wf.run(["validate", "validate-demo", "--json"])
      expect(success.exitCode).toBe(0)
      expect(() => JSON.parse(success.stdout)).not.toThrow()
      expect(success.stdout).toContain('"artifact"')
      expect(success.stdout).toContain('"graph"')

      const broken = yield* wf.write("broken.ts", 'throw new Error("json exploded")\n')
      const failure = yield* wf.run(["validate", "--file", broken, "--json"])
      expect(failure.exitCode).toBe(1)
      expect(() => JSON.parse(failure.stdout)).not.toThrow()
      expect(failure.stdout).toContain("json exploded")
      expect(failure.stderr).toBe("")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("omits the errors line when the workflow declares no typed errors", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const create = yield* wf.run(["create", "validate-demo", "--source", validWorkflowSource])
      expect(create.exitCode, create.stderr).toBe(0)

      // A workflow without typed errors serialises as JSON Schema never
      // ({"not":{}}); printing that reads like a defect in the success block.
      const result = yield* wf.run(["validate", "validate-demo", "--verbose"])
      expect(result.stdout).not.toContain("errors:")
      expect(result.stdout).not.toContain(`{"not":{}}`)
    }).pipe(Effect.provide(cliLayer)))

  it.effect("traces with --input instead of the generated sample input", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      // The traced branch depends on the input, so the flow proves --input was used.
      const file = yield* wf.write(
        "branching.ts",
        `import { defineWorkflow, t } from "@mokronos/wfkit"

export const BranchingWorkflow = defineWorkflow({
  name: "BranchingWorkflow",
  input: t.struct({ wait: t.boolean }),
  output: t.void,
  run: function* (input, ctx) {
    if (input.wait) {
      yield* ctx.sleep("1 minute", "cooldown")
    }
  }
})
`
      )

      const waiting = yield* wf.run(["validate", "--file", file, "--input", '{"wait":true}', "--verbose"])
      expect(waiting.exitCode).toBe(0)
      expect(waiting.stdout).toContain("cooldown")

      const skipped = yield* wf.run(["validate", "--file", file, "--input", '{"wait":false}', "--verbose"])
      expect(skipped.exitCode).toBe(0)
      expect(skipped.stdout).not.toContain("cooldown")
      expect(skipped.stdout).toContain("(no orchestration calls)")

      const malformed = yield* wf.run(["validate", "--file", file, "--input", "{"])
      expect(malformed.exitCode).toBe(1)
      expect(malformed.stderr).toContain("Invalid JSON input")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("requires a workflow id or file", () =>
    Effect.gen(function* () {
      const wf = yield* workspace
      const result = yield* wf.run(["validate"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("wf validate requires a workflow id or --file")
    }).pipe(Effect.provide(cliLayer)))
})
