import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const cliPath = path.join(repoRoot, "apps", "integrations", "cli", "src", "main.ts")
const decoder = new TextDecoder()
// A throwaway home, so spawning the CLI can never read the real ~/.wf.
const testHome = mkdtempSync(path.join(tmpdir(), "integrations-help-"))

const runCli = (args: ReadonlyArray<string>) => {
  const subprocess = Bun.spawnSync({
    cmd: [process.execPath, "run", cliPath, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, INTEGRATIONS_HOME: testHome, NO_COLOR: "1" }
  })
  return {
    exitCode: subprocess.exitCode,
    stdout: decoder.decode(subprocess.stdout),
    stderr: decoder.decode(subprocess.stderr)
  }
}

describe("integrations CLI help", () => {
  test("lists the whole surface from the top level", () => {
    const result = runCli(["--help"])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("SUBCOMMANDS")
    for (const command of [
      "discover",
      "search",
      "integrations",
      "tools",
      "schema",
      "connect",
      "connections",
      "disconnect",
      "execute",
      "validate",
      "grant",
      "grants",
      "revoke",
      "keys",
      "approval",
      "approve",
      "audit",
      "maintenance",
      "serve",
      "install",
      "uninstall",
      "upgrade"
    ]) {
      expect(`${command} listed: ${result.stdout.includes(command)}`)
        .toBe(`${command} listed: true`)
    }
  })

  test("keeps the old names working as aliases", () => {
    // Renaming a command in a CLI an agent has already been taught is a cost
    // paid by whoever wrote the prompt, so the previous names keep resolving.
    const result = runCli(["--help"])
    expect(result.stdout).toContain("integrations, list")
    expect(result.stdout).toContain("execute, invoke")
  })

  test("every listing command windows with --limit and --offset", () => {
    // Listings return everything by default. What they must never do is drop
    // rows silently — so the window is explicit, and it is the same window on
    // every listing rather than a different mechanism per command.
    for (
      const command of ["integrations", "tools", "connections", "clients", "audit", "approvals"]
    ) {
      const help = runCli([command, "--help"])
      expect(`${command}: ${help.exitCode}`).toBe(`${command}: 0`)
      expect(`${command} has --limit: ${help.stdout.includes("--limit")}`)
        .toBe(`${command} has --limit: true`)
      expect(`${command} has --offset: ${help.stdout.includes("--offset")}`)
        .toBe(`${command} has --offset: true`)
      expect(`${command} has --verbose: ${help.stdout.includes("--verbose")}`)
        .toBe(`${command} has --verbose: true`)
    }
  }, 30_000)

  test("offers a detached start and a service install", () => {
    // Two ways to get a gateway that stays up: `&` without knowing about `&`,
    // and a real service that survives a reboot.
    const serve = runCli(["serve", "--help"])
    expect(serve.exitCode).toBe(0)
    expect(serve.stdout).toContain("--detach")
    expect(serve.stdout).toContain("-d")

    const install = runCli(["install", "--help"])
    expect(install.exitCode).toBe(0)
    expect(install.stdout).toContain("--port")

    const upgrade = runCli(["upgrade", "--help"])
    expect(upgrade.exitCode).toBe(0)
    expect(upgrade.stdout).toContain("--check")
    expect(upgrade.stdout).toContain("--pull")
  })

  test("shows arguments and flags for a specific command", () => {
    const help = runCli(["search", "--help"])

    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("query string")
    expect(help.stdout).toContain("--verbose")
    expect(help.stdout).toContain("--kind")
    // JSON is the only output. A human-readable summary that drops fields is
    // the failure mode this CLI exists to prevent: an agent acts on what it
    // sees, and what it saw was missing every discovery URL.
    expect(help.stdout).not.toContain("--text")
  })

  test("reports a missing gateway instead of failing obscurely", () => {
    const result = runCli(["integrations"])

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("No gateway found")
  })

  test("rejects an unknown command", () => {
    const result = runCli(["missing"])
    expect(result.exitCode).not.toBe(0)
  })
})
