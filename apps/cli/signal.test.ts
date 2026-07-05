import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const tempRoot = path.join(repoRoot, ".tmp", "cli-signal-tests")
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
      NO_COLOR: "1"
    }
  })

  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

const signalWorkflowSource = `import { defineWorkflow, t } from "wf"

export const SigDemoWorkflow = defineWorkflow({
  name: "SigDemoWorkflow",
  version: 1,
  input: t.struct({}),
  output: t.string,
  run: function* (_, ctx) {
    const signal = yield* ctx.waitForSignal("approval", t.struct({ approved: t.boolean }))
    return signal.type === "signal" && signal.value.approved ? "approved" : "rejected"
  }
})
`

describe("wf signal", () => {
  test("resumes a signal-suspended CLI run from another process", () => {
    const cwd = makeTempDir()

    const create = runCli(cwd, [
      "create",
      "sig-demo",
      "--source",
      signalWorkflowSource
    ])
    expect(create.exitCode).toBe(0)

    const started = runCli(cwd, ["run", "sig-demo", "{}"])
    expect(started.exitCode).toBe(0)
    expect(started.stderr).toContain("[signal] waiting for approval")
    expect(started.stderr).toContain("wf signal")

    const runId = started.stderr.match(/\[run\] id ([^\s]+)/)?.[1]
    expect(runId).toBeDefined()

    const signaled = runCli(cwd, [
      "signal",
      runId!,
      "approval",
      "{\"approved\":true}"
    ])
    expect(signaled.exitCode).toBe(0)
    expect(signaled.stdout).toContain("approved")

    const runs = runCli(cwd, ["runs"])
    expect(runs.exitCode).toBe(0)
    expect(runs.stdout).toContain(`${runId}\tcompleted\tsig-demo@dev`)

    const alreadyCompleted = runCli(cwd, [
      "signal",
      runId!,
      "approval",
      "{\"approved\":true}"
    ])
    expect(alreadyCompleted.exitCode).not.toBe(0)
    expect(alreadyCompleted.stderr).toContain("not waiting for signal approval")
  })
})
