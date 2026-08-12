import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"

const repoRoot = path.resolve(import.meta.dir, "../../..")
const cliPath = path.join(repoRoot, "apps", "cli", "src", "main.ts")
const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const CliResult = Schema.Struct({
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String
})
type CliResult = typeof CliResult.Type

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
  return { exitCode, stdout, stderr }
}

const ToolsOutput = Schema.Struct({
  integrations: Schema.Array(Schema.Struct({
    integration: Schema.String,
    connection: Schema.String,
    tools: Schema.Array(Schema.Struct({
      name: Schema.String,
      description: Schema.String
    }))
  }))
})

const ToolSchemaOutput = Schema.Struct({
  address: Schema.String,
  name: Schema.String,
  description: Schema.String,
  input: Schema.String,
  output: Schema.String,
  next: Schema.String
})

describe("agent integration acceptance flow", () => {
  test("discovers, authenticates, authors, and invokes via one Executor catalog", async () => {
    let invocationCount = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        if (url.pathname === "/openapi.json") {
          return Response.json({
            openapi: "3.1.0",
            info: {
              title: "Agent Acceptance",
              version: "1.0.0",
              description: "Creates acceptance tickets"
            },
            servers: [{ url: `http://127.0.0.1:${server.port}` }],
            security: [{ apiKey: [] }],
            paths: {
              "/tickets": {
                post: {
                  operationId: "tickets.create",
                  requestBody: {
                    required: true,
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          required: ["title"],
                          properties: { title: { type: "string" } }
                        }
                      }
                    }
                  },
                  responses: {
                    "200": {
                      description: "Created",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            required: ["id", "title"],
                            properties: {
                              id: { type: "string" },
                              title: { type: "string" }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            components: {
              securitySchemes: {
                apiKey: { type: "apiKey", in: "header", name: "x-api-key" }
              }
            }
          })
        }
        if (url.pathname !== "/tickets") return new Response("not found", { status: 404 })
        expect(request.headers.get("x-api-key")).toBe("acceptance-secret")
        const body = await Schema.decodeUnknownPromise(
          Schema.Struct({ title: Schema.String })
        )(await request.json())
        invocationCount += 1
        return Response.json({ id: "T-1", title: body.title })
      }
    })
    servers.push(server)

    const home = await mkdtemp(path.join(os.tmpdir(), "wf-agent-executor-"))
    directories.push(home)
    const environment = {
      ...process.env,
      WF_HOME: home,
      WF_AGENT_TOKEN: "acceptance-secret"
    }
    const specUrl = `http://127.0.0.1:${server.port}/openapi.json`

    const missing = await runCli([
      "integrations",
      "tools",
      "not_in_catalog"
    ], environment)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain("Integration not found in catalog: not_in_catalog")

    const summary = await runCli(["integrations", "discover", specUrl], environment)
    expect(summary.exitCode).toBe(0)
    expect(JSON.parse(summary.stdout)).toMatchObject({
      integration: { slug: "agent_acceptance" },
      toolCount: 0,
      tools: [],
      next: "wf i connect agent_acceptance"
    })

    const textSummary = await runCli(["integrations", "discover", specUrl, "--text"], environment)
    expect(textSummary.exitCode).toBe(0)
    expect(textSummary.stdout).toContain("tools: 0")
    expect(textSummary.stdout).toContain(`next: wf i connect agent_acceptance`)
    expect(textSummary.stdout).not.toContain("input:")

    const disconnected = await runCli([
      "integrations",
      "tools",
      "agent_acceptance"
    ], environment)
    expect(disconnected.exitCode).toBe(1)
    expect(disconnected.stderr).toContain("Integration is not connected: agent_acceptance/default")

    const connected = await runCli([
      "integrations",
      "connect",
      "agent_acceptance",
      "--credential-env",
      "WF_AGENT_TOKEN"
    ], environment)
    expect(connected.exitCode).toBe(0)
    expect(JSON.parse(connected.stdout)).toMatchObject({
      toolCount: 1,
      next: "wf i tools agent_acceptance"
    })
    expect(JSON.parse(connected.stdout)).not.toHaveProperty("tools")
    expect(connected.stdout).not.toContain("acceptance-secret")

    // The listing stays at name-and-description detail, so browsing a large
    // integration does not drag every schema along with it.
    const listed = await runCli([
      "integrations",
      "tools",
      "--integration",
      "agent_acceptance"
    ], environment)
    expect(listed.exitCode).toBe(0)
    const tools = Schema.decodeUnknownSync(ToolsOutput)(JSON.parse(listed.stdout))
    const group = tools.integrations.find((entry) => entry.integration === "agent_acceptance")
    if (group === undefined) throw new Error("Executor did not group the discovered tools")
    expect(group.connection).toBe("default")
    expect(group.tools.map((tool) => tool.name)).toContain("tickets.create")
    expect(listed.stdout).not.toContain("inputSchema")
    expect(listed.stdout).not.toContain("tools.agent_acceptance.org.default")

    const concise = await runCli([
      "integrations",
      "tools",
      "agent_acceptance",
      "--text"
    ], environment)
    expect(concise.exitCode).toBe(0)
    expect(concise.stdout).toContain("agent_acceptance/default")
    expect(concise.stdout).toContain("tickets.create")
    expect(concise.stdout).toContain("next: wf i schema agent_acceptance <tool>")
    expect(concise.stdout).not.toContain("input:")

    const filtered = await runCli([
      "integrations",
      "tools",
      "--search",
      "ticket",
      "--text"
    ], environment)
    expect(filtered.exitCode).toBe(0)
    expect(filtered.stdout).toContain("tickets.create")

    const unmatched = await runCli([
      "integrations",
      "tools",
      "--search",
      "invoices",
      "--text"
    ], environment)
    expect(unmatched.exitCode).toBe(0)
    expect(unmatched.stdout).toContain('No tools match "invoices".')

    // One named tool, and only then its address and schemas.
    const detailed = await runCli([
      "integrations",
      "schema",
      "agent_acceptance",
      "tickets.create"
    ], environment)
    expect(detailed.exitCode).toBe(0)
    const createTicket = Schema.decodeUnknownSync(ToolSchemaOutput)(JSON.parse(detailed.stdout))
    expect(createTicket.address).toStartWith("tools.agent_acceptance.org.default")
    expect(createTicket.input).toContain("title")
    expect(createTicket.output).toContain("id")

    const byAddress = await runCli([
      "integrations",
      "schema",
      createTicket.address,
      "--text",
      "--verbose"
    ], environment)
    expect(byAddress.exitCode).toBe(0)
    expect(byAddress.stdout).toContain("input:")
    expect(byAddress.stdout).toContain("output:")
    expect(byAddress.stdout).toContain(`next: wf i invoke ${createTicket.address}`)

    // A bare tool name is what an agent reads off the listing, so it resolves
    // on its own while it is unambiguous.
    const byName = await runCli([
      "integrations",
      "schema",
      "tickets.create"
    ], environment)
    expect(byName.exitCode).toBe(0)
    expect(JSON.parse(byName.stdout)).toMatchObject({ address: createTicket.address })

    const slugOnly = await runCli([
      "integrations",
      "schema",
      "agent_acceptance"
    ], environment)
    expect(slugOnly.exitCode).toBe(1)
    expect(slugOnly.stderr).toContain("agent_acceptance is an integration, not a tool")

    const unknownTool = await runCli([
      "integrations",
      "schema",
      "agent_acceptance",
      "tickets.delete"
    ], environment)
    expect(unknownTool.exitCode).toBe(1)
    expect(unknownTool.stderr).toContain("Tool not found: agent_acceptance/tickets.delete")

    const unknownName = await runCli([
      "integrations",
      "schema",
      "tickets.delete"
    ], environment)
    expect(unknownName.exitCode).toBe(1)
    expect(unknownName.stderr).toContain("Tool not found: tickets.delete")

    const validated = await runCli([
      "integrations",
      "validate",
      createTicket.address,
      "--text"
    ], environment)
    expect(validated.exitCode).toBe(0)
    expect(validated.stdout).toContain("catalog\t")
    expect(validated.stdout).toContain("tickets.create is available")

    const invoked = await runCli([
      "integrations",
      "invoke",
      createTicket.address,
      JSON.stringify({ body: { title: "Direct Executor invocation" } })
    ], environment)
    expect(invoked.exitCode).toBe(0)
    expect(invoked.stdout).toContain('"title":"Direct Executor invocation"')
    expect(invocationCount).toBe(1)

    const source = `import { defineWorkflow, integration, t } from "@mokronos/wfkit"
const Output = t.struct({ id: t.string, title: t.string })
const createTicket = integration({
  source: { kind: "executor", address: ${JSON.stringify(createTicket.address)} },
  input: t.struct({ body: t.struct({ title: t.string }) }),
  output: Output
})
export const AgentAcceptance = defineWorkflow({
  name: "AgentAcceptance",
  input: t.struct({ title: t.string }),
  output: Output,
  run: function* (input, ctx) {
    return yield* ctx.run(createTicket, { body: input })
  }
})`
    const created = await runCli([
      "create",
      "agent-acceptance",
      "--source",
      source
    ], environment)
    expect(created.exitCode).toBe(0)

    const longTitle = `Executor migration ${"x".repeat(5_000)}`
    const run = await runCli([
      "run",
      "agent-acceptance",
      JSON.stringify({ title: longTitle })
    ], environment)
    expect(run.exitCode).toBe(0)
    const runResult = Schema.decodeUnknownSync(Schema.Struct({
      truncated: Schema.Literal(true),
      characters: Schema.Number,
      preview: Schema.String,
      next: Schema.String
    }))(JSON.parse(run.stdout))
    expect(runResult.preview).toContain('"id":"T-1"')
    expect(runResult.next).toContain("--verbose")
    expect(run.stderr).not.toContain(longTitle)
    expect(run.stderr).toContain("[run] completed")
    expect(run.stderr.length).toBeLessThan(2_000)
    expect(invocationCount).toBe(2)

    const stored = await readFile(path.join(home, "workflows", "agent-acceptance.ts"), "utf8")
    expect(stored).toContain(createTicket.address)
    expect(stored).not.toContain("acceptance-secret")
    expect(stored).not.toContain(specUrl)

    const storedFiles = (await readdir(home, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "executor-auth.json")
      .map((entry) => path.join(entry.parentPath, entry.name))
    const persisted = Buffer.concat(
      await Promise.all(storedFiles.map((file) => readFile(file)))
    ).toString("utf8")
    expect(persisted).not.toContain("acceptance-secret")
  }, 20_000)
})
