import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "packages", "wf", "src", "cli", "main.ts")
const decoder = new TextDecoder()

const runCli = (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
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

describe("wf help", () => {
  test("lists commands from the top level", () => {
    const result = runCli(["help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("wf - create, run, and inspect")
    expect(result.stdout).toContain("wf help <command>")
  })

  test("shows command-specific help in both supported forms", () => {
    const helpCommand = runCli(["help", "create"])
    const helpFlag = runCli(["create", "--help"])

    expect(helpCommand.exitCode).toBe(0)
    expect(helpCommand.stdout).toContain("wf create <workflow-id>")
    expect(helpFlag.exitCode).toBe(0)
    expect(helpFlag.stdout).toBe(helpCommand.stdout)
  })

  test("rejects help for an unknown command", () => {
    const result = runCli(["help", "missing"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown command: missing")
  })
})
