import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const directories: Array<string> = []
const CliResult = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
})
type CliResult = typeof CliResult.Type

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const runCli = async (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
): Promise<CliResult> => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", cliPath, ...arguments_],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: environment
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return Schema.decodeUnknownSync(CliResult)({ exitCode, stdout, stderr })
}

test("top-level CLI drains large stdout before exiting", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wf-cli-output-"))
  directories.push(home)
  const environment = { ...process.env, WF_HOME: home }
  const source = `import { defineWorkflow, t } from "@mokronos/wfkit"
export const LargeOutput = defineWorkflow({
  name: "LargeOutput",
  version: 1,
  input: t.struct({ size: t.number }),
  output: t.struct({ text: t.string }),
  run: function* (input) {
    return { text: \`\${"x".repeat(input.size)}output-complete\` }
  }
})`
  const created = await runCli([
    "create",
    "large-output",
    "--source",
    source,
    "--version",
    "1"
  ], environment)
  expect(created.exitCode).toBe(0)

  const sentinel = "output-complete"
  const input = JSON.stringify({ size: 750_000 })
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", cliPath, "run", "large-output", input],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: environment
  })
  const stdoutReader = subprocess.stdout.getReader()
  const chunks: Array<Uint8Array> = []
  while (true) {
    const chunk = await stdoutReader.read()
    if (chunk.done) break
    chunks.push(chunk.value)
    await Bun.sleep(2)
  }
  const [exitCode, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text()
  ])
  const stdout = new TextDecoder().decode(Buffer.concat(chunks))

  expect(exitCode).toBe(0)
  expect(stdout.includes(sentinel)).toBe(true)
  expect(stderr).toContain("… (+")
  expect(stderr.length).toBeLessThan(1_500)
}, 20_000)
