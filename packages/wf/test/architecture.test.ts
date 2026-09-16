import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const packageDirectory = Effect.map(Path.Path, (path) =>
  path.resolve(import.meta.dirname, ".."))

const typescriptFiles = (
  directory: string
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const entries = yield* fs.readDirectory(directory)
    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const entryPath = path.join(directory, entry)
        const info = yield* fs.stat(entryPath)
        if (info.type === "Directory") return yield* typescriptFiles(entryPath)
        return entryPath.endsWith(".ts") ? [path.resolve(entryPath)] : []
      }))
    return nested.flat()
  }).pipe(Effect.orDie)

const importedLocalFiles = Effect.fnUntraced(function* (
  file: string,
  known: ReadonlySet<string>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = yield* fs.readFileString(file)
  return Array.from(source.matchAll(/(?:from\s+|import\s*)"(\.[^"]+)"/g)).flatMap((match) => {
    const specifier = match[1]
    if (specifier === undefined) return []
    const dependency = path.resolve(path.dirname(file), specifier)
    const resolved = path.extname(dependency) === "" ? `${dependency}.ts` : dependency
    return known.has(resolved) ? [resolved] : []
  })
})

describe("package architecture", () => {
  it.effect("local package imports are acyclic", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const files = yield* typescriptFiles(path.join(yield* packageDirectory, "src"))
      const known = new Set(files)
      const dependencies = new Map<string, ReadonlyArray<string>>()
      for (const file of files) {
        dependencies.set(file, yield* importedLocalFiles(file, known))
      }

      const visited = new Set<string>()
      const stack: Array<string> = []
      const visit = (file: string): void => {
        const cycleStart = stack.indexOf(file)
        if (cycleStart >= 0) {
          throw new Error(`Import cycle: ${[...stack.slice(cycleStart), file].join(" -> ")}`)
        }
        if (visited.has(file)) return
        stack.push(file)
        for (const dependency of dependencies.get(file) ?? []) visit(dependency)
        stack.pop()
        visited.add(file)
      }
      for (const file of files) expect(() => visit(file)).not.toThrow()
    }).pipe(Effect.provide(BunServices.layer)))

  it.effect("authoring has an explicit package subpath", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const manifest = yield* fs.readFileString(path.join(yield* packageDirectory, "package.json"))

      expect(manifest).toContain('"./authoring"')
    }).pipe(Effect.provide(BunServices.layer)))

  it.effect("production TypeScript has no explicit any escape hatches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const files = yield* typescriptFiles(path.join(yield* packageDirectory, "src"))
      const explicitAny = /\b(?:as|extends)\s+any\b|[:=]\s*any\b|[<,]\s*any\s*[,>]/
      const offenders: Array<string> = []
      for (const file of files) {
        const lines = (yield* fs.readFileString(file)).split("\n")
        for (const [index, line] of lines.entries()) {
          if (explicitAny.test(line)) offenders.push(`${file}:${index + 1}`)
        }
      }
      expect(offenders).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)))

  it.effect("importing the runtime has no filesystem side effects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const runtime = path.join(yield* packageDirectory, "src/runtime.ts")
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "wf-import-" })

      const result = yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          ["-e", `await import(${JSON.stringify(runtime)})`],
          { cwd: directory, stdout: "pipe", stderr: "pipe" }
        ),
        { includeStderr: true }
      )

      expect(result).toBe("")
      expect(yield* fs.readDirectory(directory)).toEqual([])
    }).pipe(Effect.provide(BunServices.layer)))
})
