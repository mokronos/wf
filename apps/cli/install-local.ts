import { chmod, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const packageDirectory = import.meta.dirname
const repositoryDirectory = path.resolve(packageDirectory, "../..")
const entryPoint = path.join(packageDirectory, "src", "main.ts")

type Mode = "source" | "compiled"

interface Options {
  readonly mode: Mode
  readonly directory: string
}

const usage = `Install the working tree's wf onto your PATH.

Usage:
  bun run install:local [--compiled] [--dir <directory>]

  (default)     Install a shim that runs src/main.ts, so source changes take
                effect with no rebuild. The dashboard is served from
                apps/web/dist, refreshed by: bun run --cwd apps/web build
                The background service keeps running the code it started with,
                so restart it after source changes with: wf install
  --compiled    Build the current-platform binary and link that instead. Slower
                and needs a rebuild per change, but matches the published shape.
  --dir <path>  Install directory. Defaults to the first of ~/.bun/bin or
                ~/.local/bin that already exists.
`

const candidateDirectories = (): ReadonlyArray<string> => [
  path.join(homedir(), ".bun", "bin"),
  path.join(homedir(), ".local", "bin")
]

const directoryExists = async (location: string): Promise<boolean> => {
  try {
    return (await lstat(location)).isDirectory()
  } catch {
    return false
  }
}

const defaultDirectory = async (): Promise<string> => {
  for (const candidate of candidateDirectories()) {
    if (await directoryExists(candidate)) return candidate
  }
  return path.join(homedir(), ".local", "bin")
}

const parseOptions = async (argv: ReadonlyArray<string>): Promise<Options> => {
  let mode: Mode = "source"
  let directory: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--compiled") {
      mode = "compiled"
      continue
    }
    if (argument === "--dir") {
      const value = argv[index + 1]
      if (value === undefined) throw new Error("--dir requires a directory")
      directory = path.resolve(value)
      index += 1
      continue
    }
    throw new Error(`Unknown option: ${argument}\n\n${usage}`)
  }
  return { mode, directory: directory ?? await defaultDirectory() }
}

const run = async (command: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: repositoryDirectory,
    stdout: "inherit",
    stderr: "inherit"
  })
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`)
}

const compiledBinaryPath = (): string => {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const binary = process.platform === "win32" ? "wf.exe" : "wf"
  return path.join(packageDirectory, "dist", "npm", "variants", `${platform}-${process.arch}`, "bin", binary)
}

// Replaces a previous install of either shape, and refuses to touch anything else.
const clearTarget = async (target: string): Promise<void> => {
  let existing
  try {
    existing = await lstat(target)
  } catch {
    return
  }
  if (existing.isSymbolicLink()) {
    await rm(target)
    return
  }
  if (!existing.isFile()) throw new Error(`Refusing to replace ${target}: not a file or symlink`)
  const contents = await Bun.file(target).text()
  if (!contents.includes(entryPoint) && !contents.includes("Local development install of wf")) {
    throw new Error(`Refusing to replace ${target}: not a wf local install. Move it aside first.`)
  }
  await rm(target)
}

const installShim = async (target: string): Promise<void> => {
  await writeFile(
    target,
    `#!/usr/bin/env sh
# Local development install of wf, written by: bun run install:local
# Runs the working tree at ${repositoryDirectory} directly, so source changes take
# effect with no rebuild. Re-run install:local after moving the repository.
exec ${process.execPath} ${entryPoint} "$@"
`,
    { mode: 0o755 }
  )
}

const installCompiled = async (target: string): Promise<void> => {
  await run(["bun", "run", "--cwd", "apps/cli", "build"])
  const binary = compiledBinaryPath()
  if (!(await Bun.file(binary).exists())) throw new Error(`Build did not produce ${binary}`)
  await symlink(binary, target)
}

// A different wf earlier in PATH would silently win, so say so rather than let it confuse.
// Package runners prepend every ancestor node_modules/.bin, which an interactive shell
// does not have, so those entries are skipped to avoid warning about a phantom.
const shellPathEntries = (): ReadonlyArray<string> => {
  const injected = `node_modules${path.sep}.bin`
  return (process.env["PATH"] ?? "").split(path.delimiter)
    .filter((entry) => entry.length > 0 && !entry.endsWith(injected))
}

const resolvesToTarget = async (candidate: string, target: string): Promise<boolean> =>
  candidate === target ||
  await readlink(candidate)
    .then((value) => path.resolve(path.dirname(candidate), value) === target)
    .catch(() => false)

const reportShadowing = async (target: string): Promise<void> => {
  const name = path.basename(target)
  for (const entry of shellPathEntries()) {
    const candidate = path.join(entry, name)
    if (!(await Bun.file(candidate).exists())) continue
    if (await resolvesToTarget(candidate, target)) return
    console.log(`\nwarning: PATH resolves ${name} to ${candidate}, which shadows this install.`)
    return
  }
  console.log(`\nwarning: ${path.dirname(target)} is not on your PATH — add it to use ${name}.`)
}

const main = async (): Promise<void> => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage)
    return
  }
  const options = await parseOptions(process.argv.slice(2))
  const target = path.join(options.directory, process.platform === "win32" ? "wf.exe" : "wf")
  await mkdir(options.directory, { recursive: true })
  await clearTarget(target)
  if (options.mode === "source") await installShim(target)
  else await installCompiled(target)
  await chmod(target, 0o755).catch(() => undefined)
  console.log(`installed wf -> ${target} (${options.mode})`)
  if (options.mode === "source") {
    console.log(`runs ${entryPoint}; no rebuild needed after source changes`)
    // The shim only affects new processes; a running service still holds the old code.
    console.log("restart the dashboard service to pick up source changes: wf install")
  }
  await reportShadowing(target)
}

try {
  await main()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : "install:local failed"}`)
  process.exit(1)
}
