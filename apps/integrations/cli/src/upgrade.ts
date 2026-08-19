import { whenPresent } from "./optional.ts"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

/** Upgrading a CLI: work out how this copy was installed, then use the thing
 * that installed it.
 *
 * This lives in the integrations CLI rather than being duplicated into the
 * workflow CLI because `wf` already depends on `@mokronos/integrations-cli` —
 * the dependency direction the repository declares — so shared CLI plumbing
 * belongs in the lower package. `i upgrade` and `wf upgrade` differ only in the
 * package name they pass. */

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn"

export interface PackageOwner {
  /** The name of the outermost installed package the files belong to. */
  readonly name: string
  readonly root: string
}

/** A published install: the binary or entry point sits inside a `node_modules`
 * tree. The *first* `node_modules` in the path is the one that matters — a
 * nested one belongs to a dependency, and upgrading a dependency in place is
 * not something a package manager will keep. */
export const packageOwner = (location: string): PackageOwner | undefined => {
  const marker = `${path.sep}node_modules${path.sep}`
  const index = location.indexOf(marker)
  if (index === -1) return undefined
  const segments = location.slice(index + marker.length).split(path.sep).filter((s) => s.length > 0)
  const first = segments[0]
  if (first === undefined) return undefined
  const scoped = first.startsWith("@")
  const second = segments[1]
  if (scoped && second === undefined) return undefined
  const name = scoped ? `${first}/${second}` : first
  return { name, root: path.join(location.slice(0, index), "node_modules", ...name.split("/")) }
}

/** Which manager owns a global tree, read off the path it installs into. Anything
 *  else that is still a `node_modules` tree is npm's layout. */
export const managerFor = (root: string): PackageManager | undefined => {
  const parts = root.split(path.sep)
  const has = (...names: ReadonlyArray<string>): boolean => names.every((name) => parts.includes(name))
  if (has(".bun", "install", "global")) return "bun"
  if (has(".yarn") || has("yarn", "global")) return "yarn"
  if (has("pnpm") || has(".pnpm-global")) return "pnpm"
  return parts.includes("node_modules") ? "npm" : undefined
}

export const upgradeCommand = (
  manager: PackageManager,
  packageName: string,
  version: string
): ReadonlyArray<string> => {
  const specifier = `${packageName}@${version}`
  switch (manager) {
    case "bun":
      return ["bun", "add", "--global", specifier]
    case "npm":
      return ["npm", "install", "--global", specifier]
    case "pnpm":
      return ["pnpm", "add", "--global", specifier]
    case "yarn":
      return ["yarn", "global", "add", specifier]
  }
}

export interface WorkspaceInstall {
  readonly _tag: "workspace"
  /** The repository the entry point is inside. */
  readonly repository: string
}

export interface PackageInstall {
  readonly _tag: "package"
  readonly manager: PackageManager
  readonly owner: PackageOwner
}

export interface UnknownInstall {
  readonly _tag: "unknown"
  readonly location: string
}

export type InstallKind = WorkspaceInstall | PackageInstall | UnknownInstall

/** A checkout is marked by `.git`, which is a directory in the main checkout
 *  and a *file* pointing at it in a worktree. Only accepting the directory
 *  makes a worktree look like it is not a checkout at all. */
const isCheckout = async (location: string): Promise<boolean> =>
  await stat(location).then((entry) => entry.isDirectory() || entry.isFile()).catch(() => false)

const repositoryAbove = async (location: string): Promise<string | undefined> => {
  let directory = path.dirname(location)
  for (;;) {
    if (await isCheckout(path.join(directory, ".git"))) return directory
    const parent = path.dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export interface InstallProbe {
  /** `Bun.main` — the entry point, which is inside the virtual filesystem for a
   *  compiled binary and a real path for a source install. */
  readonly entry: string
  /** `process.execPath` — the compiled binary itself, or bun. */
  readonly executable: string
}

const isVirtual = (entry: string): boolean =>
  entry.startsWith("/$bunfs/") || entry.startsWith("B:\\~BUN\\")

export const describeInstall = async (probe: InstallProbe): Promise<InstallKind> => {
  const location = isVirtual(probe.entry) ? probe.executable : probe.entry
  const owner = packageOwner(location)
  if (owner !== undefined) {
    const manager = managerFor(owner.root)
    if (manager !== undefined) return { _tag: "package", manager, owner }
  }
  const repository = await repositoryAbove(location)
  return repository === undefined ? { _tag: "unknown", location } : { _tag: "workspace", repository }
}

const RegistryVersion = Schema.Struct({ version: Schema.String })
const decodeRegistryVersion = Schema.decodeUnknownPromise(RegistryVersion)

const registryBase = (environment: NodeJS.ProcessEnv): string => {
  const configured = environment["npm_config_registry"] ?? environment["NPM_CONFIG_REGISTRY"]
  const base = configured === undefined || configured.length === 0
    ? "https://registry.npmjs.org"
    : configured
  return base.endsWith("/") ? base.slice(0, -1) : base
}

/** `undefined` when the registry has no such package: for an unpublished CLI
 *  that is the answer, not an error to paper over. */
export const latestPublishedVersion = async (
  packageName: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> => {
  const url = `${registryBase(environment)}/${packageName.replace("/", "%2f")}/latest`
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  }).catch((error) => {
    throw new Error(
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return (await decodeRegistryVersion(await response.json())).version
}

const InstalledPackage = Schema.Struct({ version: Schema.String })
const decodeInstalledPackage = Schema.decodeUnknownPromise(InstalledPackage)

const installedVersion = async (root: string): Promise<string | undefined> => {
  const manifest = Bun.file(path.join(root, "package.json"))
  if (!(await manifest.exists())) return undefined
  return (await decodeInstalledPackage(await manifest.json())).version
}

const runInherited = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
  const [program, ...arguments_] = command
  if (program === undefined) throw new Error("Empty command")
  const child = Bun.spawn([program, ...arguments_], {
    ...whenPresent("cwd", cwd),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`)
}

const capture = async (command: ReadonlyArray<string>, cwd: string): Promise<string> => {
  const [program, ...arguments_] = command
  if (program === undefined) throw new Error("Empty command")
  const child = Bun.spawn([program, ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`)
  return stdout.trim()
}

export interface UpgradeOptions {
  /** The package to upgrade — the CLI's own name, not whatever package happens
   *  to own the file on disk: a platform binary is installed as a dependency of
   *  its wrapper. */
  readonly packageName: string
  readonly currentVersion: string
  /** How the user invoked this, for messages that suggest the next command. */
  readonly command: string
  /** Fast-forward a source checkout instead of refusing to touch it. */
  readonly pull: boolean
  /** Report what an upgrade would do and change nothing. */
  readonly check: boolean
  /** What to run to rebuild a locally compiled binary. Pulling sources leaves a
   *  compiled copy on the old code, and only the caller knows its build. */
  readonly rebuildHint?: string
  readonly probe?: InstallProbe
}

export interface UpgradeResult {
  readonly changed: boolean
  readonly lines: ReadonlyArray<string>
}

const probeDefault = (): InstallProbe => ({ entry: Bun.main, executable: process.execPath })

const describeInstallKind = (install: InstallKind, compiled: boolean): string => {
  switch (install._tag) {
    case "workspace":
      return compiled
        ? `a binary built from the checkout at ${install.repository}`
        : `a source checkout at ${install.repository}`
    case "package":
      return `${install.owner.name} installed by ${install.manager} in ${install.owner.root}`
    case "unknown":
      return `an install this command does not recognise (${install.location})`
  }
}

/** Fast-forwards the checkout the CLI runs from. Deliberately narrow: it
 * refuses a dirty tree and anything that is not a fast-forward, because the
 * point is to update a CLI, not to resolve someone's merge. */
const pullRepository = async (
  repository: string,
  rebuildHint: string | undefined
): Promise<UpgradeResult> => {
  const dirty = await capture(["git", "status", "--porcelain"], repository)
  if (dirty.length > 0) {
    throw new Error(
      `${repository} has uncommitted changes. Commit or stash them first — upgrade will not pull over your work.`
    )
  }
  const before = await capture(["git", "rev-parse", "--short", "HEAD"], repository)
  await runInherited(["git", "pull", "--ff-only"], repository)
  const after = await capture(["git", "rev-parse", "--short", "HEAD"], repository)
  if (before === after) {
    return { changed: false, lines: [`Already up to date at ${after}.`] }
  }
  const touched = await capture(["git", "diff", "--name-only", `${before}..${after}`], repository)
  const dependenciesMoved = touched.split("\n").some((file) =>
    file === "bun.lock" || file.endsWith("package.json")
  )
  if (dependenciesMoved) {
    // Sources run straight from the tree, so a moved lockfile means the next
    // command imports something that is not installed yet.
    await runInherited([process.execPath, "install"], repository)
  }
  return {
    changed: true,
    lines: [
      `Updated ${repository}: ${before} → ${after}.`,
      ...(dependenciesMoved ? ["Dependencies changed, so bun install ran."] : []),
      ...(rebuildHint === undefined ? [] : [`This copy is a compiled binary: rebuild it with ${rebuildHint}`])
    ]
  }
}

const upgradePackage = async (
  install: PackageInstall,
  options: UpgradeOptions
): Promise<UpgradeResult> => {
  const latest = await latestPublishedVersion(options.packageName)
  if (latest === undefined) {
    throw new Error(
      `${options.packageName} is not published yet, so there is no version to upgrade to.`
    )
  }
  if (latest === options.currentVersion) {
    return { changed: false, lines: [`Already on the latest version (${latest}).`] }
  }
  await runInherited(upgradeCommand(install.manager, options.packageName, latest))
  const now = await installedVersion(install.owner.root)
  return {
    changed: true,
    lines: [
      `${options.packageName} ${options.currentVersion} → ${now ?? latest}.`
    ]
  }
}

export const upgradeCli = async (options: UpgradeOptions): Promise<UpgradeResult> => {
  const probe = options.probe ?? probeDefault()
  const install = await describeInstall(probe)
  // A compiled binary built from this checkout keeps running the code it was
  // built from, so pulling sources is only half of its upgrade.
  const rebuildHint = isVirtual(probe.entry) ? options.rebuildHint : undefined
  if (options.check) {
    const latest = install._tag === "package"
      ? await latestPublishedVersion(options.packageName)
      : undefined
    return {
      changed: false,
      lines: [
        `Version ${options.currentVersion}, running from ${describeInstallKind(install, rebuildHint !== undefined)}.`,
        ...(install._tag === "package"
          ? [
            latest === undefined
              ? `${options.packageName} is not published yet.`
              : latest === options.currentVersion
              ? `${options.packageName} is up to date (${latest}).`
              : `${options.packageName} ${latest} is available. Upgrade with: ${options.command}`
          ]
          : install._tag === "workspace"
          ? [
            `Update it with: ${options.command} --pull, or git pull yourself.`,
            ...(rebuildHint === undefined ? [] : [`Then rebuild it with ${rebuildHint}`])
          ]
          : [])
      ]
    }
  }
  switch (install._tag) {
    case "package":
      return await upgradePackage(install, options)
    case "workspace":
      return options.pull
        ? await pullRepository(install.repository, rebuildHint)
        : {
          changed: false,
          lines: [
            rebuildHint === undefined
              ? `This is a source install: it runs the working tree at ${install.repository} directly, so there is no published package to replace.`
              : `This is a binary built from the checkout at ${install.repository}, not a published package.`,
            `Fast-forward the checkout with: ${options.command} --pull`
          ]
        }
    case "unknown":
      throw new Error(
        `Cannot tell how this copy was installed (${install.location}), so it cannot upgrade itself. Reinstall it with your package manager.`
      )
  }
}
