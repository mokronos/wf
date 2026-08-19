import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { serveGateway } from "@mokronos/integrations"
import type { RunningGateway } from "@mokronos/integrations"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const integrationsCli = path.join(repoRoot, "apps", "integrations", "cli", "src", "main.ts")
const wfCli = path.join(repoRoot, "apps", "cli", "src", "main.ts")

const servers: Array<ReturnType<typeof Bun.serve>> = []
const gateways: Array<RunningGateway> = []
/** Decodes CLI output against the shape a test expects. Using a schema rather
 *  than a cast means the test fails when the CLI's output drifts, which is the
 *  whole point of an acceptance test. Struct ignores excess properties, so a
 *  command is still free to report more than the test names. */
const parseOutput = <A>(schema: Schema.Codec<A>, text: string): A =>
  Schema.decodeUnknownSync(schema)(JSON.parse(text))

const ApiKeyConfig = Schema.Struct({ apiKey: Schema.String })
const IdOutput = Schema.Struct({ id: Schema.String })
const SecretOutput = Schema.Struct({ secret: Schema.String })
const KeyOutput = Schema.Struct({ id: Schema.String, secret: Schema.String })
const CountOutput = Schema.Struct({ count: Schema.Number })
const DiscoveredOutput = Schema.Struct({
  integration: Schema.Struct({ slug: Schema.String })
})
const ConnectionsOutput = Schema.Struct({
  connections: Schema.Array(Schema.Struct({ address: Schema.String, name: Schema.String }))
})
const GrantsOutput = Schema.Struct({
  grants: Schema.Array(Schema.Struct({
    alias: Schema.String,
    tool: Schema.String,
    integration: Schema.String,
    decision: Schema.String
  }))
})
const GrantCountOutput = Schema.Struct({ grants: Schema.Array(Schema.Json) })
const FrozenOutput = Schema.Struct({ status: Schema.String, approvalId: Schema.String })
const AuditOutput = Schema.Struct({
  records: Schema.Array(Schema.Struct({ outcome: Schema.String }))
})
const ClientsOutput = Schema.Struct({
  clients: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
})
const DirectOutcome = Schema.Struct({
  status: Schema.String,
  result: Schema.Struct({ title: Schema.String })
})
const ToolsOutput = Schema.Struct({
  count: Schema.Number,
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  showing: Schema.optional(Schema.Number)
})
const WindowedToolsOutput = Schema.Struct({
  count: Schema.Number,
  showing: Schema.Number,
  offset: Schema.Number,
  tools: Schema.Array(Schema.Json)
})
const KeysOutput = Schema.Struct({
  keys: Schema.Array(Schema.Struct({
    id: Schema.String,
    revokedAt: Schema.NullOr(Schema.String)
  }))
})

const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()))
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

const run = async (
  cli: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string | undefined>>
) => {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, "run", cli, ...args],
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

/** A vendor: an OpenAPI document plus the endpoint it describes, guarded by an
 *  API key the gateway must inject. */
const startVendor = () => {
  let invocations = 0
  const seenKeys: Array<string | null> = []
  const server = Bun.serve({
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const baseUrl = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/api/search") {
        return Response.json({
          results: [{
            domain: "acceptance.test",
            name: "Acceptance Tickets",
            description: "Creates tickets for the acceptance journey",
            kinds: ["openapi"],
            url: baseUrl
          }]
        })
      }
      if (url.pathname === "/api/acceptance.test/surface") {
        return Response.json({
          surfaces: [{
            type: "openapi",
            slug: "acceptance-tickets",
            name: "Acceptance Tickets",
            spec: `${baseUrl}/openapi.json`
          }]
        })
      }
      if (url.pathname === "/openapi.json") {
        return Response.json({
          openapi: "3.1.0",
          info: { title: "Acceptance", version: "1.0.0", description: "Creates tickets" },
          servers: [{ url: baseUrl }],
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
                          properties: { id: { type: "string" }, title: { type: "string" } }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          components: {
            securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } }
          }
        })
      }
      if (url.pathname !== "/tickets") return new Response("not found", { status: 404 })
      seenKeys.push(request.headers.get("x-api-key"))
      const body = await Schema.decodeUnknownPromise(
        Schema.Struct({ title: Schema.String })
      )(await request.json())
      invocations += 1
      return Response.json({ id: "T-1", title: body.title })
    }
  })
  servers.push(server)
  return {
    specUrl: `http://127.0.0.1:${server.port}/openapi.json`,
    registryUrl: `http://127.0.0.1:${server.port}`,
    invocations: () => invocations,
    seenKeys: () => seenKeys
  }
}

const startGateway = async (registryUrl?: string) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wf-acceptance-"))
  directories.push(home)
  const gateway = await serveGateway({
    home,
    port: 0,
    registryUrl
  })
  gateways.push(gateway)
  const config = await readFile(path.join(home, "gateway.json"), "utf8")
  const { apiKey } = parseOutput(ApiKeyConfig, config)
  return {
    home,
    url: gateway.url,
    apiKey,
    environment: {
      ...process.env,
      WF_HOME: home,
      INTEGRATIONS_HOME: home,
      INTEGRATIONS_URL: gateway.url,
      INTEGRATIONS_API_KEY: apiKey,
      ACCEPTANCE_TOKEN: "acceptance-secret",
      NO_COLOR: "1"
    }
  }
}

describe("integrations CLI acceptance", () => {
  test(
    "an agent searches, discovers, connects, inspects, and invokes a connection — all through the gateway",
    async () => {
      const vendor = startVendor()
      const gateway = await startGateway(vendor.registryUrl)
      const integrations = (args: ReadonlyArray<string>) =>
        run(integrationsCli, args, gateway.environment)

      const searched = await integrations(["search", "acceptance tickets"])
      expect(searched.exitCode, searched.stderr).toBe(0)
      const SearchBody = Schema.Struct({
        query: Schema.String,
        results: Schema.Array(Schema.Struct({
          name: Schema.String,
          surfaces: Schema.Array(Schema.Struct({ discoveryUrl: Schema.optional(Schema.String) }))
        }))
      })
      const searchBody = Schema.decodeUnknownSync(SearchBody)(JSON.parse(searched.stdout))
      expect(searchBody.query).toBe("acceptance tickets")
      expect(searchBody.results).toHaveLength(1)
      expect(searchBody.results[0]?.name).toBe("Acceptance Tickets")
      const discoveryUrl = searchBody.results[0]?.surfaces[0]?.discoveryUrl
      expect(discoveryUrl).toBe(vendor.specUrl)

      const discovered = await integrations(["discover", discoveryUrl ?? ""])
      expect(discovered.exitCode, discovered.stderr).toBe(0)
      const DiscoverBody = Schema.Struct({
        integration: Schema.Struct({ slug: Schema.String }),
        next: Schema.String
      })
      const discoveredBody = Schema.decodeUnknownSync(DiscoverBody)(
        JSON.parse(discovered.stdout)
      )
      const slug = discoveredBody.integration.slug
      // Listings tell an agent what to do next rather than making it guess.
      expect(discoveredBody.next).toBe(`integrations connect ${slug}`)

      const connected = await integrations([
        "connect",
        slug,
        "--credential-env",
        "ACCEPTANCE_TOKEN"
      ])
      expect(connected.exitCode, connected.stderr).toBe(0)
      // The credential was read from this process's environment and handed to
      // the gateway; it is never echoed back.
      expect(connected.stdout).not.toContain("acceptance-secret")

      const tools = await integrations(["tools", slug])
      expect(tools.exitCode, tools.stderr).toBe(0)
      expect(tools.stdout).toContain("tickets.create")

      const schema = await integrations(["schema", slug, "tickets.create"])
      expect(schema.exitCode, schema.stderr).toBe(0)
      expect(schema.stdout).toContain("title")

      const listed = parseOutput(ConnectionsOutput, (await integrations(["connections"])).stdout)
      const address = listed.connections[0]?.address ?? ""
      expect(address).toStartWith(`tools.${slug}.org.`)

      // invoke is privileged and takes an address: this is how an agent proves a
      // connection works right after making it.
      const invoked = await integrations([
        "invoke",
        `${address}.tickets.create`,
        JSON.stringify({ body: { title: "Direct" } })
      ])
      expect(invoked.exitCode, invoked.stderr).toBe(0)
      expect(invoked.stdout).toContain("T-1")
      expect(vendor.invocations()).toBe(1)
      // The gateway injected the credential; the caller never saw it.
      expect(vendor.seenKeys()).toEqual(["acceptance-secret"])
    },
    30_000
  )

  test("a delegated key reaches only what it was granted", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(integrationsCli, args, environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    const client = parseOutput(IdOutput, (await integrations(["client", "sandbox"])).stdout)
    const key = parseOutput(SecretOutput, (await integrations(["key", client.id])).stdout)
    const sandbox = {
      ...gateway.environment,
      INTEGRATIONS_API_KEY: key.secret
    }

    // Nothing granted yet.
    const beforeGrant = await integrations(["grants", "--mine"], sandbox)
    expect(beforeGrant.exitCode, beforeGrant.stderr).toBe(0)
    expect(JSON.parse(beforeGrant.stdout)).toEqual({ grants: [], count: 0 })

    // A sandbox key cannot mint capabilities for itself.
    const escalation = await integrations(["client", "escalated"], sandbox)
    expect(escalation.exitCode).toBe(1)
    // Says what was refused and what would fix it, because a capability
    // refusal is fixed with a different key rather than a different request.
    expect(escalation.stderr).toContain("may not change")
    expect(escalation.stderr).toContain("may mutate")

    const discoverAttempt = await integrations(["discover", vendor.specUrl], sandbox)
    expect(discoverAttempt.exitCode).toBe(1)

    await integrations([
      "grant",
      client.id,
      "tickets",
      "tickets.create",
      "--integration",
      slug
    ])

    const afterGrant = parseOutput(GrantsOutput, (await integrations(["grants", "--mine"], sandbox)).stdout)
    expect(afterGrant.grants).toEqual([
      { alias: "tickets", tool: "tickets.create", integration: slug, decision: "allow" }
    ])

    const executed = await integrations([
      "execute",
      "tickets",
      "tickets.create",
      JSON.stringify({ body: { title: "Delegated" } })
    ], sandbox)
    expect(executed.exitCode, executed.stderr).toBe(0)
    expect(executed.stdout).toContain("succeeded")
    expect(vendor.seenKeys()).toEqual(["acceptance-secret"])

    // An ungranted tool on a granted alias is refused.
    const refused = await integrations([
      "execute",
      "tickets",
      "tickets.delete",
      "{}"
    ], sandbox)
    expect(refused.exitCode).toBe(1)
  }, 30_000)

  test("a require-approval grant freezes the call until a human decides", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(integrationsCli, args, environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
    const client = parseOutput(IdOutput, (await integrations(["client", "sales"])).stdout)
    const key = parseOutput(SecretOutput, (await integrations(["key", client.id])).stdout)
    await integrations([
      "grant",
      client.id,
      "tickets",
      "tickets.create",
      "--integration",
      slug,
      "--require-approval"
    ])

    const frozen = parseOutput(FrozenOutput, (await integrations([
      "execute",
      "tickets",
      "tickets.create",
      JSON.stringify({ body: { title: "Needs a human" } })
    ], { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret })).stdout)

    expect(frozen.status).toBe("pending")
    expect(vendor.invocations()).toBe(0)

    const approved = await integrations(["approve", frozen.approvalId, "--by", "sebastian"])
    expect(approved.exitCode, approved.stderr).toBe(0)
    // The gateway performed the frozen call itself.
    expect(vendor.invocations()).toBe(1)

    const audit = parseOutput(AuditOutput, (await integrations(["audit"])).stdout)
    expect(audit.records.map((entry) => entry.outcome)).toContain("succeeded")
  }, 30_000)

  test("a workflow authored against the catalog runs and keeps secrets out of its source", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>) =>
      run(integrationsCli, args, gateway.environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    // The workflow names an alias, so the local client needs a grant binding
    // that alias to the connection just made. This is the deployment-time
    // binding from ADR 0003: the definition is portable, the grant is not.
    const clients = parseOutput(ClientsOutput, (await integrations(["clients"])).stdout)
    const local = clients.clients.find((entry) => entry.name === "local")
    expect(local).toBeDefined()
    const granted = await integrations([
      "grant",
      local?.id ?? "",
      "tickets",
      "tickets.create",
      "--integration",
      slug
    ])
    expect(granted.exitCode, granted.stderr).toBe(0)

    const source = `import { defineWorkflow, integration, t } from "@mokronos/wfkit"
const Output = t.struct({ id: t.string, title: t.string })
const createTicket = integration({
  source: { kind: "gateway", alias: "tickets", tool: "tickets.create" },
  input: t.struct({ body: t.struct({ title: t.string }) }),
  output: Output
})
export const Acceptance = defineWorkflow({
  name: "Acceptance",
  input: t.struct({ title: t.string }),
  output: Output,
  run: function* (input, ctx) {
    return yield* ctx.run(createTicket, { body: input })
  }
})`
    const created = await run(wfCli, ["create", "acceptance", "--source", source], gateway.environment)
    expect(created.exitCode, created.stderr).toBe(0)

    const validated = await run(wfCli, ["validate", "acceptance"], gateway.environment)
    expect(validated.exitCode, validated.stderr).toBe(0)
    expect(validated.stdout).toContain("ready")

    const ran = await run(
      wfCli,
      ["run", "acceptance", JSON.stringify({ title: "From a workflow" })],
      gateway.environment
    )
    expect(ran.exitCode, ran.stderr).toBe(0)
    expect(ran.stdout).toContain("T-1")
    expect(vendor.invocations()).toBe(1)

    const stored = await readFile(path.join(gateway.home, "workflows", "acceptance.ts"), "utf8")
    expect(stored).toContain("tickets.create")
    // The definition names an alias and a tool. Not the integration slug, not
    // the connection that served it, not the credential behind it — so handing
    // this file to someone else needs only a grant on their side.
    expect(stored).not.toContain(slug)
    expect(stored).not.toContain("acceptance-secret")
    expect(stored).not.toContain(vendor.specUrl)

    const files = (await readdir(gateway.home, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name !== "executor-auth.json")
      .map((entry) => path.join(entry.parentPath, entry.name))
    const persisted = Buffer.concat(
      await Promise.all(files.map((file) => readFile(file)))
    ).toString("utf8")
    expect(persisted).not.toContain("acceptance-secret")
  }, 40_000)

  test("every result is JSON a reader can parse, whole", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(integrationsCli, args, environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    // A tool result is the machine-facing payload. Cutting the document to
    // save tokens does not make it a smaller answer, it makes it unusable, so
    // the default output has to parse.
    const direct = await integrations([
      "execute",
      "--direct",
      `tools.${slug}.org.default.tickets.create`,
      JSON.stringify({ body: { title: "x".repeat(2000) } })
    ])
    expect(direct.exitCode, direct.stderr).toBe(0)
    const outcome = parseOutput(DirectOutcome, direct.stdout)
    expect(outcome.status).toBe("succeeded")
    expect(outcome.result.title).toHaveLength(2000)

    // The previous name for the same thing still resolves.
    const aliased = await integrations([
      "invoke",
      `tools.${slug}.org.default.tickets.create`,
      JSON.stringify({ body: { title: "Through the old name" } })
    ])
    expect(aliased.exitCode, aliased.stderr).toBe(0)
    expect(JSON.parse(aliased.stdout)).toHaveProperty("status", "succeeded")

    // A refusal is an answer, and it arrives as one: parseable, with a
    // non-zero exit code to say which answer it was.
    const client = parseOutput(IdOutput, (await integrations(["client", "sandbox"])).stdout)
    const key = parseOutput(SecretOutput, (await integrations(["key", client.id])).stdout)
    const refused = await integrations(
      ["execute", "nothing", "tickets.create", "{}"],
      { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret }
    )
    expect(refused.exitCode).toBe(1)
    expect(JSON.parse(refused.stdout)).toHaveProperty("status", "denied")
  }, 40_000)

  test("listings return every row, and window only when asked", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>) =>
      run(integrationsCli, args, gateway.environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])

    const whole = parseOutput(ToolsOutput, (await integrations(["tools", slug])).stdout)
    // Nothing is held back behind a flag the reader did not know to pass.
    expect(whole.tools).toHaveLength(whole.count)
    expect(whole.showing).toBeUndefined()

    const windowed = parseOutput(
      WindowedToolsOutput,
      (await integrations(["tools", slug, "--limit", "1", "--offset", "0"])).stdout
    )
    expect(windowed.tools).toHaveLength(1)
    expect(windowed.showing).toBe(1)
    expect(windowed.count).toBe(whole.count)

    // The old name for the catalog listing still works.
    const catalog = parseOutput(CountOutput, (await integrations(["list"])).stdout)
    expect(catalog.count).toBeGreaterThan(0)
  }, 40_000)

  test("a grant can be revoked, and a key listed and revoked, from the CLI", async () => {
    const vendor = startVendor()
    const gateway = await startGateway()
    const integrations = (args: ReadonlyArray<string>, environment = gateway.environment) =>
      run(integrationsCli, args, environment)

    const discovered = parseOutput(DiscoveredOutput, (await integrations(["discover", vendor.specUrl])).stdout)
    const slug = discovered.integration.slug
    await integrations(["connect", slug, "--credential-env", "ACCEPTANCE_TOKEN"])
    const client = parseOutput(IdOutput, (await integrations(["client", "sandbox"])).stdout)
    const key = parseOutput(KeyOutput, (await integrations(["key", client.id])).stdout)
    const sandbox = { ...gateway.environment, INTEGRATIONS_API_KEY: key.secret }
    const grant = parseOutput(IdOutput, (await integrations([
      "grant",
      client.id,
      "tickets",
      "tickets.create",
      "--integration",
      slug
    ])).stdout)

    const keys = parseOutput(KeysOutput, (await integrations(["keys", client.id])).stdout)
    expect(keys.keys.map((entry) => entry.id)).toEqual([key.id])

    // Undoing a delegation was the one thing the CLI could not do.
    const revokedGrant = await integrations(["revoke", "grant", grant.id])
    expect(revokedGrant.exitCode, revokedGrant.stderr).toBe(0)
    const afterRevoke = parseOutput(GrantCountOutput, (await integrations(["grants", "--mine"], sandbox)).stdout)
    expect(afterRevoke.grants).toEqual([])

    const revokedKey = await integrations(["revoke", "key", key.id])
    expect(revokedKey.exitCode, revokedKey.stderr).toBe(0)
    const withRevokedKey = await integrations(["grants", "--mine"], sandbox)
    expect(withRevokedKey.exitCode).toBe(1)
  }, 40_000)
})
