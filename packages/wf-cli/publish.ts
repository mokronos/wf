import { readdir } from "node:fs/promises"
import path from "node:path"

const packageDirectory = import.meta.dirname
const npmDirectory = path.join(packageDirectory, "dist", "npm")
const variantsDirectory = path.join(npmDirectory, "variants")
const dryRun = process.argv.includes("--dry-run")

const publish = async (directory: string, tag: string): Promise<void> => {
  const arguments_ = [
    "publish",
    "--access",
    "public",
    "--tag",
    tag,
    ...(process.env["GITHUB_ACTIONS"] === "true" ? ["--provenance"] : []),
    ...(dryRun ? ["--dry-run"] : [])
  ]
  const child = Bun.spawn(["npm", ...arguments_], {
    cwd: directory,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  if (await child.exited !== 0) throw new Error(`npm ${arguments_.join(" ")} failed in ${directory}`)
}

const main = async (): Promise<void> => {
  const variants = (await readdir(variantsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const variant of variants) {
    await publish(path.join(variantsDirectory, variant), variant)
  }
  await publish(path.join(npmDirectory, "wrapper"), "latest")
}

await main()
