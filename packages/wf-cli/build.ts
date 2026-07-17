import { chmod, cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import packageMetadata from "./package.json" with { type: "json" }

const packageDirectory = import.meta.dirname
const repositoryDirectory = path.resolve(packageDirectory, "../..")
const webDirectory = path.join(repositoryDirectory, "apps", "web")
const distributionDirectory = path.join(packageDirectory, "dist")
const embeddedAssetsPath = path.join(packageDirectory, "src", "embedded-web-assets.gen.ts")
const embeddedAssetsStub = `export interface EmbeddedWebAsset {
  readonly base64: string
  readonly contentType: string
}

const assets: Readonly<Record<string, EmbeddedWebAsset>> = {}

export default assets
`

interface EmbeddedAsset {
  readonly base64: string
  readonly contentType: string
}

interface BuildTarget {
  readonly tag: string
  readonly bunTarget: string
  readonly npmOs: "darwin" | "linux" | "win32"
  readonly cpu: "arm64" | "x64"
  readonly libc?: "glibc" | "musl"
  readonly binary: "wf" | "wf.exe"
}

const targets: ReadonlyArray<BuildTarget> = [
  { tag: "darwin-arm64", bunTarget: "bun-darwin-arm64", npmOs: "darwin", cpu: "arm64", binary: "wf" },
  { tag: "darwin-x64", bunTarget: "bun-darwin-x64", npmOs: "darwin", cpu: "x64", binary: "wf" },
  { tag: "linux-arm64", bunTarget: "bun-linux-arm64", npmOs: "linux", cpu: "arm64", libc: "glibc", binary: "wf" },
  { tag: "linux-arm64-musl", bunTarget: "bun-linux-arm64-musl", npmOs: "linux", cpu: "arm64", libc: "musl", binary: "wf" },
  { tag: "linux-x64", bunTarget: "bun-linux-x64", npmOs: "linux", cpu: "x64", libc: "glibc", binary: "wf" },
  { tag: "linux-x64-musl", bunTarget: "bun-linux-x64-musl", npmOs: "linux", cpu: "x64", libc: "musl", binary: "wf" },
  { tag: "windows-arm64", bunTarget: "bun-windows-arm64", npmOs: "win32", cpu: "arm64", binary: "wf.exe" },
  { tag: "windows-x64", bunTarget: "bun-windows-x64", npmOs: "win32", cpu: "x64", binary: "wf.exe" }
]

const contentType = (file: string): string => {
  if (file.endsWith(".html")) return "text/html; charset=utf-8"
  if (file.endsWith(".css")) return "text/css; charset=utf-8"
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (file.endsWith(".svg")) return "image/svg+xml"
  if (file.endsWith(".png")) return "image/png"
  if (file.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

const filesBelow = async (directory: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const location = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(location) : [location]
  }))
  return nested.flat()
}

const run = async (command: ReadonlyArray<string>): Promise<void> => {
  const child = Bun.spawn([...command], {
    cwd: repositoryDirectory,
    stdout: "inherit",
    stderr: "inherit"
  })
  if (await child.exited !== 0) throw new Error(`${command.join(" ")} failed`)
}

const generateEmbeddedAssets = async (): Promise<void> => {
  const outputDirectory = path.join(webDirectory, "dist")
  const files = await filesBelow(outputDirectory)
  const entries = await Promise.all(files.map(async (file): Promise<readonly [string, EmbeddedAsset]> => {
    const urlPath = `/${path.relative(outputDirectory, file).replaceAll(path.sep, "/")}`
    const base64 = Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")
    return [urlPath, { base64, contentType: contentType(file) }]
  }))
  const source = `${embeddedAssetsStub.slice(0, embeddedAssetsStub.indexOf("const assets"))}const assets: Readonly<Record<string, EmbeddedWebAsset>> = ${JSON.stringify(Object.fromEntries(entries))}\n\nexport default assets\n`
  await writeFile(embeddedAssetsPath, source)
}

const currentTarget = (): BuildTarget => {
  const platform = process.platform === "win32" ? "windows" : process.platform
  const tag = `${platform}-${process.arch}`
  const target = targets.find((candidate) => candidate.tag === tag)
  if (target === undefined) throw new Error(`Unsupported build platform: ${tag}`)
  return target
}

const aliasName = (target: BuildTarget): string => `@mokronos/wf-${target.tag}`

const variantVersion = (target: BuildTarget): string => `${packageMetadata.version}-${target.tag}`

const writePlatformPackage = async (target: BuildTarget): Promise<void> => {
  const directory = path.join(distributionDirectory, "npm", "variants", target.tag)
  const binaryPath = path.join(directory, "bin", target.binary)
  await mkdir(path.dirname(binaryPath), { recursive: true })
  await run([
    "bun",
    "build",
    "--compile",
    "--target",
    target.bunTarget,
    "--outfile",
    binaryPath,
    "packages/wf-cli/src/main.ts"
  ])
  if (target.npmOs !== "win32") await chmod(binaryPath, 0o755)
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    name: packageMetadata.name,
    version: variantVersion(target),
    description: `${packageMetadata.description} (${target.tag})`,
    license: packageMetadata.license,
    repository: packageMetadata.repository,
    os: [target.npmOs],
    cpu: [target.cpu],
    ...(target.libc === undefined ? {} : { libc: [target.libc] }),
    files: ["bin"],
    publishConfig: packageMetadata.publishConfig
  }, null, 2) + "\n")
}

const writeWrapperPackage = async (): Promise<void> => {
  const directory = path.join(distributionDirectory, "npm", "wrapper")
  await mkdir(path.join(directory, "bin"), { recursive: true })
  await cp(path.join(packageDirectory, "bin", "wf.cjs"), path.join(directory, "bin", "wf.cjs"))
  await cp(path.join(packageDirectory, "README.md"), path.join(directory, "README.md"))
  await writeFile(path.join(directory, "package.json"), JSON.stringify({
    ...packageMetadata,
    files: ["bin", "README.md"],
    optionalDependencies: Object.fromEntries(
      targets.map((target) => [aliasName(target), `npm:${packageMetadata.name}@${variantVersion(target)}`])
    )
  }, null, 2) + "\n")
}

const main = async (): Promise<void> => {
  await rm(distributionDirectory, { recursive: true, force: true })
  await run(["bun", "run", "--cwd", "apps/web", "build"])
  await generateEmbeddedAssets()
  try {
    const selectedTargets = process.argv.includes("--all") ? targets : [currentTarget()]
    for (const target of selectedTargets) await writePlatformPackage(target)
    await writeWrapperPackage()
  } finally {
    await writeFile(embeddedAssetsPath, embeddedAssetsStub)
  }
}

await main()
