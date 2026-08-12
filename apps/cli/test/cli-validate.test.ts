import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const tempRoot = path.join(repoRoot, ".tmp", "cli-validate-tests")
const decoder = new TextDecoder()

let currentTempDir: string | undefined

const makeTempDir = () => {
  mkdirSync(tempRoot, { recursive: true })
  currentTempDir = path.join(tempRoot, crypto.randomUUID())
  mkdirSync(currentTempDir, { recursive: true })
  return currentTempDir
}

afterEach(() => {
  if (currentTempDir !== undefined) {
    rmSync(currentTempDir, { recursive: true, force: true })
    currentTempDir = undefined
  }
})

const runCli = (cwd: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WF_HOME: cwd,
      NO_COLOR: "1"
    }
  })

  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

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

const integrationWorkflowSource = `import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const lookup = integration({
  source: { kind: "executor", address: "tools.missing.org.default.lookup" },
  input: t.struct({ query: t.string }),
  output: t.string
})

export const MissingIntegrationWorkflow = defineWorkflow({
  name: "MissingIntegrationWorkflow",
  input: t.struct({ query: t.string }),
  output: t.string,
  run: function* (input, ctx) {
    return yield* ctx.run(lookup, input)
  }
})
`

const partiallyInvalidIntegrationWorkflowSource = `import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const lookup = integration({
  source: { kind: "executor", address: "tools.missing.org.default.lookup" },
  input: t.struct({ query: t.string }),
  output: t.string
})

export const PartiallyInvalidIntegrationWorkflow = defineWorkflow({
  name: "PartiallyInvalidIntegrationWorkflow",
  input: t.struct({ query: t.string }),
  output: t.string,
  run: function* (input, ctx) {
    yield* ctx.run(lookup, input)
    return yield* ctx.code("explode-after-integration", {
      reason: "Exercise integration reporting from a partial trace",
      output: t.string,
      run: () => { throw new Error("trace exploded") }
    })
  }
})
`

describe("wf validate", () => {
  test("summarizes validation and reveals the traced flow with --verbose", () => {
    const cwd = makeTempDir()
    const create = runCli(cwd, ["create", "validate-demo", "--source", validWorkflowSource])
    expect(create.exitCode, create.stderr).toBe(0)

    const result = runCli(cwd, ["validate", "validate-demo"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Valid validate-demo")
    expect(result.stdout).toContain("ValidateDemoWorkflow")
    expect(result.stdout).toContain("1 orchestration call")
    expect(result.stdout).not.toContain("input:")
    expect(result.stdout).not.toContain("PrintMessage")

    const verbose = runCli(cwd, ["validate", "validate-demo", "--verbose"])
    expect(verbose.stdout).toContain("input:")
    expect(verbose.stdout).toContain("flow:")
    expect(verbose.stdout).toContain("PrintMessage")
  })

  test("validates an unregistered workflow file", () => {
    const cwd = makeTempDir()
    const file = path.join(cwd, "Unregistered Workflow.ts")
    writeFileSync(file, validWorkflowSource)

    const result = runCli(cwd, ["validate", "--file", file])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Valid unregistered-workflow")
    expect(result.stdout).toContain("ValidateDemoWorkflow")
  })

  test("reports module and export diagnostics", () => {
    const cwd = makeTempDir()
    const throwsAtModuleScope = path.join(cwd, "throws.ts")
    const noWorkflowExport = path.join(cwd, "no-workflow.ts")
    writeFileSync(throwsAtModuleScope, 'throw new Error("module exploded")\n')
    writeFileSync(noWorkflowExport, "export const value = 1\n")

    const thrown = runCli(cwd, ["validate", "--file", throwsAtModuleScope])
    expect(thrown.exitCode).toBe(1)
    expect(thrown.stderr).toContain("Invalid throws")
    expect(thrown.stderr).toContain("module exploded")

    const missing = runCli(cwd, ["validate", "--file", noWorkflowExport])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("Invalid no-workflow")
    expect(missing.stderr).toContain("did not export a wf workflow")
  })

  test("emits complete JSON for successful and failing validation", () => {
    const cwd = makeTempDir()
    const create = runCli(cwd, ["create", "validate-demo", "--source", validWorkflowSource])
    expect(create.exitCode, create.stderr).toBe(0)

    const success = runCli(cwd, ["validate", "validate-demo", "--json"])
    expect(success.exitCode).toBe(0)
    expect(() => JSON.parse(success.stdout)).not.toThrow()
    expect(success.stdout).toContain('"artifact"')
    expect(success.stdout).toContain('"graph"')

    const broken = path.join(cwd, "broken.ts")
    writeFileSync(broken, 'throw new Error("json exploded")\n')
    const failure = runCli(cwd, ["validate", "--file", broken, "--json"])
    expect(failure.exitCode).toBe(1)
    expect(() => JSON.parse(failure.stdout)).not.toThrow()
    expect(failure.stdout).toContain("json exploded")
    expect(failure.stderr).toBe("")
  })

  test("omits the errors line when the workflow declares no typed errors", () => {
    const cwd = makeTempDir()
    const create = runCli(cwd, ["create", "validate-demo", "--source", validWorkflowSource])
    expect(create.exitCode, create.stderr).toBe(0)

    // A workflow without typed errors serialises as JSON Schema never
    // ({"not":{}}); printing that reads like a defect in the success block.
    const result = runCli(cwd, ["validate", "validate-demo", "--verbose"])
    expect(result.stdout).not.toContain("errors:")
    expect(result.stdout).not.toContain(`{"not":{}}`)
  })

  test("traces with --input instead of the generated sample input", () => {
    const cwd = makeTempDir()
    const file = path.join(cwd, "branching.ts")
    // The traced branch depends on the input, so the flow proves --input was used.
    writeFileSync(
      file,
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

    const waiting = runCli(cwd, ["validate", "--file", file, "--input", '{"wait":true}', "--verbose"])
    expect(waiting.exitCode).toBe(0)
    expect(waiting.stdout).toContain("cooldown")

    const skipped = runCli(cwd, ["validate", "--file", file, "--input", '{"wait":false}', "--verbose"])
    expect(skipped.exitCode).toBe(0)
    expect(skipped.stdout).not.toContain("cooldown")
    expect(skipped.stdout).toContain("(no orchestration calls)")

    const malformed = runCli(cwd, ["validate", "--file", file, "--input", "{"])
    expect(malformed.exitCode).toBe(1)
    expect(malformed.stderr).toContain("Invalid JSON input")
  })

  test("requires a workflow id or file", () => {
    const result = runCli(makeTempDir(), ["validate"])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("wf validate requires a workflow id or --file")
  })

  test("reports every missing integration address reached by the trace", () => {
    const cwd = makeTempDir()
    const file = path.join(cwd, "missing-integration.ts")
    writeFileSync(file, integrationWorkflowSource)

    const result = runCli(cwd, ["validate", "--file", file])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("integrations:")
    expect(result.stdout).toContain("missing\ttools.missing.org.default.lookup")
    expect(result.stderr).toContain("needs 1 integration tool connected")
  })

  test("includes integration readiness in JSON validation output", () => {
    const cwd = makeTempDir()
    const file = path.join(cwd, "missing-integration.ts")
    writeFileSync(file, integrationWorkflowSource)

    const result = runCli(cwd, ["validate", "--file", file, "--json"])
    const output = JSON.parse(result.stdout)

    expect(result.exitCode).toBe(1)
    expect(output.integrations).toHaveLength(1)
    expect(output.integrations[0]).toMatchObject({
      address: "tools.missing.org.default.lookup",
      report: { ok: false }
    })
  })

  test("reports reached integrations even when a later trace node fails", () => {
    const cwd = makeTempDir()
    const file = path.join(cwd, "partially-invalid-integration.ts")
    writeFileSync(file, partiallyInvalidIntegrationWorkflowSource)

    const result = runCli(cwd, ["validate", "--file", file])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("integrations:")
    expect(result.stdout).toContain("tools.missing.org.default.lookup")
    expect(result.stderr).toContain("trace exploded")
  })
})
