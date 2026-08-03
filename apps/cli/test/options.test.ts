import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const decoder = new TextDecoder()
// A throwaway home, so spawning the CLI can never read or write the real ~/.wf.
const testHome = mkdtempSync(path.join(tmpdir(), "wf-cli-options-"))

const runCli = (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WF_HOME: testHome, NO_COLOR: "1" }
  })
  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

describe("dashboard options", () => {
  test("parses dashboard options through Effect CLI", () => {
    const result = runCli(["web", "--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("--foreground")
    expect(result.stdout).toContain("--port integer")
    expect(result.stdout).toContain("--no-open")
  })

  test("rejects invalid ports in the command handler", () => {
    const result = runCli(["web", "--foreground", "--port", "70000", "--no-open"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("between 1 and 65535")
  })
})
