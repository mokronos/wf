import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const tempRoot = path.join(repoRoot, ".tmp", "cli-progressive-output-tests")
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

const runCli = (home: string, args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: home,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WF_HOME: home, NO_COLOR: "1" }
  })
  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

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
  test("workflow listings are bounded unless verbose", () => {
    const home = makeTempDir()
    for (let index = 0; index < 22; index++) {
      const id = `workflow-${String(index).padStart(2, "0")}`
      const created = runCli(home, ["create", id, "--source", workflowSource(index)])
      expect(created.exitCode, created.stderr).toBe(0)
    }

    const listed = runCli(home, ["list"])
    expect(listed.exitCode, listed.stderr).toBe(0)
    expect(listed.stdout.trim().split("\n")).toHaveLength(11)
    expect(listed.stdout).toContain("Showing 10 of 22")
    expect(listed.stdout).not.toContain("bytes")

    const verbose = runCli(home, ["list", "--verbose"])
    expect(verbose.exitCode, verbose.stderr).toBe(0)
    expect(verbose.stdout.trim().split("\n")).toHaveLength(22)
    expect(verbose.stdout).toContain("bytes")
    expect(verbose.stdout).not.toContain("Showing 10 of 22")
  }, 20_000)

  test("history defaults to recent event identities", () => {
    const home = makeTempDir()
    const created = runCli(home, ["create", "history-demo", "--source", workflowSource(1)])
    expect(created.exitCode, created.stderr).toBe(0)
    const run = runCli(home, ["run", "history-demo"])
    expect(run.exitCode, run.stderr).toBe(0)
    const runId = run.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
    expect(runId).toBeDefined()

    const history = runCli(home, ["history", runId!])
    expect(history.exitCode, history.stderr).toBe(0)
    expect(history.stdout).toContain("workflow.completed")
    expect(history.stdout).not.toContain('"result"')

    const verbose = runCli(home, ["history", runId!, "--verbose"])
    expect(verbose.exitCode, verbose.stderr).toBe(0)
    expect(verbose.stdout).toContain('"result"')
  }, 15_000)

  test("workflow logs are available only in verbose mode", () => {
    const home = makeTempDir()
    const created = runCli(home, ["create", "logging-demo", "--source", loggingWorkflowSource])
    expect(created.exitCode, created.stderr).toBe(0)
    expect(created.stdout).not.toContain("module-noise")

    const concise = runCli(home, ["run", "logging-demo"])
    expect(concise.exitCode, concise.stderr).toBe(0)
    expect(concise.stdout).toBe("1\n")
    expect(concise.stdout).not.toContain("noise")

    const verbose = runCli(home, ["run", "logging-demo", "--verbose"])
    expect(verbose.exitCode, verbose.stderr).toBe(0)
    expect(verbose.stdout).toBe("1\n")
    expect(verbose.stderr).toContain("module-noise")
    expect(verbose.stderr).toContain("run-noise")
  }, 15_000)

  test("verbose JSON validation keeps stdout parseable", () => {
    const home = makeTempDir()
    const file = path.join(home, "json-logging.ts")
    writeFileSync(file, jsonLoggingWorkflowSource)

    const validated = runCli(home, ["validate", "--file", file, "--json", "--verbose"])
    expect(validated.exitCode, validated.stderr).toBe(0)
    expect(() => JSON.parse(validated.stdout)).not.toThrow()
    expect(validated.stderr).toContain("json-module-noise")
  })
})
