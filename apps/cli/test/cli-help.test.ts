import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "cli", "main.ts")
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

  test("generates nested integrations help from the command hierarchy", () => {
    const parent = runCli(["integrations"])
    const helpCommand = runCli(["help", "integrations"])
    const helpFlag = runCli(["integrations", "--help"])
    const subcommandHelp = runCli(["integrations", "discover", "--help"])

    expect(parent.exitCode).toBe(0)
    expect(parent.stdout).toContain("SUBCOMMANDS")
    expect(parent.stdout).toContain("discover")
    expect(helpCommand.stdout).toBe(parent.stdout)
    expect(helpFlag.stdout).toBe(parent.stdout)
    expect(subcommandHelp.stdout).toContain("ARGUMENTS")
    expect(subcommandHelp.stdout).toContain("url string")
  })

  test("rejects help for an unknown command", () => {
    const result = runCli(["help", "missing"])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Unknown command: missing")
  })
})
