import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const tempRoot = path.join(repoRoot, ".tmp", "cli-catalog-tests")
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
  test("stores each workflow as an editable file under WF_HOME", async () => {
    const home = makeTempDir()

    const created = runCli(home, ["create", "file-demo", "--source", workflowSource("first")])
    expect(created.exitCode, created.stderr).toBe(0)

    const workflowFile = path.join(home, "workflows", "file-demo.ts")
    expect(created.stdout).toContain(workflowFile)
    expect(await readFile(workflowFile, "utf8")).toBe(workflowSource("first"))

    const listed = runCli(home, ["list"])
    expect(listed.exitCode, listed.stderr).toBe(0)
    const [id, updated, file] = listed.stdout.trim().split("\t")
    expect(id).toBe("file-demo")
    expect(updated).toMatch(/^updated \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(file).toBe(workflowFile)
    expect(listed.stdout).not.toContain("bytes")

    // No database is created for the catalog: the files are the catalog.
    expect(await readdir(home)).not.toContain("wf.sqlite")
  })

  test("runs a workflow that was edited on disk, with no CLI involved in the edit", async () => {
    const home = makeTempDir()
    expect(runCli(home, ["create", "file-demo", "--source", workflowSource("first")]).exitCode).toBe(0)

    const first = runCli(home, ["run", "file-demo", "{\"message\":\"hello\"}"])
    expect(first.exitCode, first.stderr).toBe(0)
    expect(first.stdout).toContain("first:hello")

    // The kind of edit an agent makes with its own file tools.
    await writeFile(path.join(home, "workflows", "file-demo.ts"), workflowSource("second"), "utf8")

    const second = runCli(home, ["run", "file-demo", "{\"message\":\"hello\"}"])
    expect(second.exitCode, second.stderr).toBe(0)
    expect(second.stdout).toContain("second:hello")
  }, 20_000)

  test("rejects missing workflow input without creating a run", () => {
    const home = makeTempDir()
    expect(runCli(home, ["create", "file-demo", "--source", workflowSource("first")]).exitCode).toBe(0)

    const invalid = runCli(home, ["run", "file-demo"])
    expect(invalid.exitCode).not.toBe(0)
    expect(invalid.stderr).toContain("Missing key")
    expect(invalid.stderr).not.toContain("[run] id")
    expect(invalid.stderr).not.toContain("[workflow] started")

    const runs = runCli(home, ["runs"])
    expect(runs.exitCode, runs.stderr).toBe(0)
    expect(runs.stdout).toContain("No workflow runs found.")
  }, 20_000)

  test("a workflow file with no workflow export is rejected without replacing the file", async () => {
    const home = makeTempDir()
    expect(runCli(home, ["create", "file-demo", "--source", workflowSource("first")]).exitCode).toBe(0)

    const broken = runCli(home, ["create", "file-demo", "--force", "--source", "export const nope = 1\n"])
    expect(broken.exitCode).not.toBe(0)
    expect(await readFile(path.join(home, "workflows", "file-demo.ts"), "utf8")).toBe(
      workflowSource("first")
    )
  })

  test("resumes a suspended run against the source it started with, not the edited file", async () => {
    const home = makeTempDir()
    expect(runCli(home, ["create", "gate", "--source", signalSource("approved-v1")]).exitCode).toBe(0)

    const started = runCli(home, ["run", "gate", "{}"])
    expect(started.exitCode, started.stderr).toBe(0)
    expect(started.stderr).toContain("[signal] waiting for approval")
    const runId = started.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
    expect(runId).toBeDefined()

    // Edit while the run is parked on the signal.
    await writeFile(path.join(home, "workflows", "gate.ts"), signalSource("approved-v2"), "utf8")

    const signaled = runCli(home, ["signal", runId!, "approval", "{\"approved\":true}"])
    expect(signaled.exitCode, signaled.stderr).toBe(0)
    expect(signaled.stdout).toContain("approved-v1")
    expect(signaled.stdout).not.toContain("approved-v2")

    // A new run picks up the edit.
    const afterEdit = runCli(home, ["run", "gate", "{}"])
    const newRunId = afterEdit.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
    expect(newRunId).toBeDefined()
    const newSignaled = runCli(home, ["signal", newRunId!, "approval", "{\"approved\":true}"])
    expect(newSignaled.exitCode, newSignaled.stderr).toBe(0)
    expect(newSignaled.stdout).toContain("approved-v2")
  }, 30_000)
})
