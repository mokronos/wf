import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path, Scope, Stream } from "effect"
import type { PlatformError } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export interface CliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface CliOptions {
  /** The CLI's `WF_HOME`. Omit for a throwaway directory scoped to the test, so
   *  a spawned CLI can never read or write the real `~/.wf`. */
  readonly home?: string
  /** Extra environment layered over the inherited one. */
  readonly env?: Record<string, string>
  readonly cwd?: string
}

export type CliServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

/** Bun-backed platform services for the suites that drive the real CLI. */
export const cliLayer: Layer.Layer<CliServices> = BunServices.layer

export const repoRoot = Effect.map(Path.Path, (path) =>
  path.resolve(import.meta.dirname, "../../.."))

/** A throwaway `WF_HOME`, released when the surrounding test scope closes. */
export const cliHome: Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "wf-cli-" }))

/** As {@link cliHome}, but inside the repository so a workflow authored there
 *  still resolves `@mokronos/wfkit` through the workspace's node_modules. */
export const cliWorkspace: Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(yield* repoRoot, ".tmp")
  yield* fs.makeDirectory(directory, { recursive: true })
  return yield* fs.makeTempDirectoryScoped({ directory, prefix: "wf-cli-" })
})

const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

/** Runs the CLI from source in a child process and collects its full output. */
export const runCli = Effect.fn("runCli")(function* (
  args: ReadonlyArray<string>,
  options: CliOptions = {}
) {
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = options.cwd ?? (yield* repoRoot)
  const entrypoint = path.join(yield* repoRoot, "apps", "cli", "src", "main.ts")
  const home = options.home ?? (yield* cliHome)

  const command = ChildProcess.make(process.execPath, ["run", entrypoint, ...args], {
    cwd: root,
    env: { ...process.env, WF_HOME: home, NO_COLOR: "1", ...options.env },
    stdout: "pipe",
    stderr: "pipe"
  })

  const handle = yield* spawner.spawn(command)
  // Both pipes are drained while the wait is in flight: a child that fills a
  // pipe buffer would otherwise block before it could exit.
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
    { concurrency: 3 }
  )
  return { exitCode, stdout, stderr } satisfies CliResult
})
