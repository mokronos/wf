import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const decoder = new TextDecoder()
// A throwaway home, so spawning the CLI can never read or write the real ~/.wf.
const testHome = mkdtempSync(path.join(tmpdir(), "wf-cli-help-"))

const runCli = (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      WF_HOME: testHome,
      NO_COLOR: "1"
    }
  })

  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

describe("CLI help", () => {
  test("lists commands from the top level", () => {
    const result = runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Durable workflows and a local dashboard")
    expect(result.stdout).toContain("install")
  })

  test("shows command-specific help from the command definition", () => {
    const helpFlag = runCli(["create", "--help"])

    expect(helpFlag.exitCode).toBe(0)
    expect(helpFlag.stdout).toContain("workflow-id string")
    expect(helpFlag.stdout).toContain("--file string")
    expect(helpFlag.stdout).toContain("--force")
    expect(helpFlag.stdout).toContain("--verbose")
  })

  test("rejects help for an unknown command", () => {
    const result = runCli(["missing"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown subcommand \"missing\"")
  })
})
