import { readdir } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

const packageDirectory = import.meta.dirname
const npmDirectory = path.join(packageDirectory, "dist", "npm")
const variantsDirectory = path.join(npmDirectory, "variants")
const dryRun = process.argv.includes("--dry-run")
const PackageIdentity = Schema.Struct({
  name: Schema.String,
  version: Schema.String
})

const alreadyPublished = async (directory: string): Promise<boolean> => {
  const identity = await Schema.decodeUnknownPromise(PackageIdentity)(
    await Bun.file(path.join(directory, "package.json")).json()
  )
  const child = Bun.spawn(
    ["npm", "view", `${identity.name}@${identity.version}`, "version"],
    { stdout: "ignore", stderr: "ignore" }
  )
  return await child.exited === 0
}

const publish = async (directory: string, tag: string): Promise<void> => {
  if (!dryRun && await alreadyPublished(directory)) {
    console.log(`Skipping already-published package in ${directory}`)
    return
  }
  const arguments_ = dryRun
    ? ["pack", "--dry-run"]
    : [
        "publish",
        "--access",
        "public",
        "--tag",
        tag,
        ...(process.env["GITHUB_ACTIONS"] === "true" ? ["--provenance"] : [])
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

  if (variants.length === 0) {
    throw new Error(`No built variants found in ${variantsDirectory}; refusing to publish the wrapper`)
  }
  for (const variant of variants) {
    await publish(path.join(variantsDirectory, variant), variant)
  }
  await publish(path.join(npmDirectory, "wrapper"), "latest")
}

await main()
