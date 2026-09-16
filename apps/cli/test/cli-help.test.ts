import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { cliLayer, runCli } from "./run-cli.ts"

describe("CLI help", () => {
  it.effect("lists commands from the top level", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["--help"])

      assert.strictEqual(result.exitCode, 0)
      assert.include(result.stdout, "Durable workflows and a local dashboard")
      assert.include(result.stdout, "install")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("shows command-specific help from the command definition", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["create", "--help"])

      assert.strictEqual(result.exitCode, 0)
      assert.include(result.stdout, "workflow-id string")
      assert.include(result.stdout, "--file string")
      assert.include(result.stdout, "--force")
      assert.include(result.stdout, "--verbose")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("generates dashboard command help from flags and descriptions", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["web", "--help"])

      assert.strictEqual(result.exitCode, 0)
      assert.include(result.stdout, "Open the installed local dashboard")
      assert.include(result.stdout, "--foreground")
      assert.include(result.stdout, "--port integer")
      assert.include(result.stdout, "--no-open")
    }).pipe(Effect.provide(cliLayer)))

  it.effect("rejects help for an unknown command", () =>
    Effect.gen(function* () {
      const result = yield* runCli(["missing"])

      assert.notStrictEqual(result.exitCode, 0)
      assert.include(result.stderr, 'Unknown subcommand "missing"')
    }).pipe(Effect.provide(cliLayer)))
})
