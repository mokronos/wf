import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..")
const temporaryDirectories: string[] = []
const DependencyMap = Schema.Record(Schema.String, Schema.String)
const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(DependencyMap),
  devDependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
  optionalDependencies: Schema.optional(DependencyMap)
})

const typescriptFiles = async (directory: string): Promise<ReadonlyArray<string>> => {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await typescriptFiles(entryPath))
    } else if (entryPath.endsWith(".ts")) {
      files.push(resolve(entryPath))
    }
  }
  return files
}

const assertNoImportCycles = async (roots: ReadonlyArray<string>): Promise<void> => {
  const files = (await Promise.all(roots.map(typescriptFiles))).flat()
  const knownFiles = new Set(files)
  const dependencies = new Map<string, ReadonlyArray<string>>()
  for (const file of files) {
    const imports = Array.from((await readFile(file, "utf8")).matchAll(
      /(?:from\s+|import\s*)"(\.[^"]+)"/g
    )).flatMap((match) => {
      const specifier = match[1]
      if (specifier === undefined) return []
      const dependency = resolve(dirname(file), specifier)
      const resolved = extname(dependency) === "" ? `${dependency}.ts` : dependency
      return knownFiles.has(resolved) ? [resolved] : []
    })
    dependencies.set(file, imports)
  }

  const visited = new Set<string>()
  const stack: string[] = []
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
  for (const file of files) visit(file)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })))
})

describe("package architecture", () => {
  test("local package imports are acyclic", async () => {
    await assertNoImportCycles([join(packageDirectory, "src")])
  })

  test("the authoring package does not depend on gateway implementations", async () => {
    const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(PackageManifest))(
      await readFile(join(packageDirectory, "package.json"), "utf8")
    )
    const dependencySections = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies
    ]

    expect(dependencySections.every((dependencies) =>
      dependencies?.["@mokronos/integrations"] === undefined &&
      dependencies?.["@mokronos/integrations-executor"] === undefined
    )).toBe(true)
  })

  test("local steps cannot invoke integrations outside first-class integration steps", async () => {
    const workflowModel = await readFile(join(packageDirectory, "src", "workflow-model.ts"), "utf8")
    const integrationStep = await readFile(join(packageDirectory, "src", "integration.ts"), "utf8")

    expect(workflowModel).not.toContain("invokeIntegration")
    expect(integrationStep).not.toContain("execute:")
    expect(integrationStep).toContain('kind: "integration"')
  })

  test("authoring and integration contracts have explicit package subpaths", async () => {
    const packageJson = await readFile(join(packageDirectory, "package.json"), "utf8")

    expect(packageJson).toContain('"./authoring"')
    expect(packageJson).toContain('"./integrations"')
  })

  test("the workflow CLI reaches integrations only through the gateway", async () => {
    const cliRoot = await readFile(
      join(packageDirectory, "..", "..", "apps", "cli", "src", "main.ts"),
      "utf8"
    )
    const workflowCommands = await readFile(
      join(packageDirectory, "..", "..", "apps", "cli", "src", "cli", "main.ts"),
      "utf8"
    )

    // wf holds no credentials and composes no Executor of its own. It is a
    // gateway client like any other, which is what keeps the privileged
    // boundary in one process. The gateway owns that boundary in its repository.
    for (const source of [cliRoot, workflowCommands]) {
      expect(source).not.toContain("createExecutorHost")
      expect(source).not.toContain("createExecutorServices")
      expect(source).not.toContain("setExecutorStorageDirectory")
      expect(source).not.toContain("@mokronos/wfkit-executor")
    }
    // Where wf does reach integrations, it is through the thin gateway client.
    expect(workflowCommands).toContain("@mokronos/integrations-client")
    // ...and the dashboard does not reach them at all any more: the gateway
    // serves its own control plane, which is the only surface holding the
    // privileged API. wf serves workflows and runs.
    expect(cliRoot).not.toContain("/api/integrations")
  })

  test("production TypeScript has no explicit any escape hatches", async () => {
    const files = await typescriptFiles(join(packageDirectory, "src"))
    const explicitAny = /\b(?:as|extends)\s+any\b|[:=]\s*any\b|[<,]\s*any\s*[,>]/
    const offenders: string[] = []
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n")
      for (const [index, line] of lines.entries()) {
        if (explicitAny.test(line)) {
          offenders.push(`${file}:${index + 1}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test("importing the runtime has no filesystem side effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-import-"))
    temporaryDirectories.push(directory)

    const process = Bun.spawn({
      cmd: ["bun", "-e", `await import(${JSON.stringify(join(packageDirectory, "src/runtime.ts"))})`],
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe"
    })
    const exitCode = await process.exited
    const stderr = await new Response(process.stderr).text()

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory }))).toEqual([])
  })
})
