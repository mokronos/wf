import { describe, expect, it } from "@effect/vitest"
import { Effect, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { cliHome, cliLayer, repoRoot, runCli } from "./run-cli.ts"

const LargeOutput = Schema.Struct({
  truncated: Schema.Literal(true),
  characters: Schema.Number,
  preview: Schema.String,
  next: Schema.String
})

const workflowSource = `import { defineWorkflow, t } from "@mokronos/wfkit"
export const LargeOutput = defineWorkflow({
  name: "LargeOutput",
  input: t.struct({ size: t.number }),
  output: t.struct({ text: t.string }),
  run: function* (input) {
    return { text: \`\${"x".repeat(input.size)}output-complete\` }
  }
})`

describe("CLI output", () => {
  // Live clock: the slow reader below is the subject of the test, so the
  // delays between reads have to be real ones.
  it.live("drains large stdout before exiting", () =>
    Effect.gen(function* () {
      const home = yield* cliHome
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* repoRoot
      const entrypoint = path.join(root, "apps", "cli", "src", "main.ts")

      const created = yield* runCli(["create", "large-output", "--source", workflowSource], { home })
      expect(created.exitCode, created.stderr).toBe(0)

      const input = JSON.stringify({ size: 750_000 })
      const command = ChildProcess.make(
        process.execPath,
        ["run", entrypoint, "run", "large-output", input],
        {
          cwd: root,
          env: { ...process.env, WF_HOME: home, NO_COLOR: "1" },
          stdout: "pipe",
          stderr: "pipe"
        }
      )

      const { exitCode, stderr, stdout } = yield* Effect.scoped(Effect.gen(function* () {
        const handle = yield* spawner.spawn(command)
        // A slow reader is the point: the CLI must keep the pipe fed and still
        // exit cleanly rather than losing the tail of a large payload.
        const slowStdout = handle.stdout.pipe(
          Stream.tap(() => Effect.sleep("2 millis")),
          Stream.decodeText(),
          Stream.mkString
        )
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [slowStdout, handle.stderr.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: 3 }
        )
        return { exitCode, stdout, stderr }
      }))

      expect(exitCode).toBe(0)
      const output = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LargeOutput))(stdout)
      expect(output.characters).toBeGreaterThan(750_000)
      expect(output.preview.length).toBeLessThanOrEqual(800)
      expect(stderr).toContain("[run] completed")
      expect(stderr.length).toBeLessThan(1_500)
    }).pipe(Effect.provide(cliLayer)), 60_000)
})
