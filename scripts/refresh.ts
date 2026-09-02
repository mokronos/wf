/** `bun run refresh` — update the local command and dashboard service from this checkout. */
const run = async (arguments_: ReadonlyArray<string>): Promise<void> => {
  const command = ["bun", "run", ...arguments_]
  const process = Bun.spawn(command, {
    cwd: import.meta.dir + "/..",
    stdout: "inherit",
    stderr: "inherit"
  })
  if (await process.exited !== 0) throw new Error(`${command.join(" ")} failed`)
}

const refresh = async (): Promise<void> => {
  await run(["build:dashboard"])
  await run(["install:local"])
  await run(["apps/cli/src/main.ts", "install"])
}

try {
  await refresh()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : "refresh failed"}`)
  process.exitCode = 1
}
