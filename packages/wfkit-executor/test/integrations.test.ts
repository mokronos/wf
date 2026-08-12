import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  closeExecutor,
  decodeIntegrationsResponse,
  ExecutorToolAddress,
  listExecutorIntegrations,
  normalizeExecutorToolOutputSchema,
  normalizeExecutorToolResult,
  setExecutorStorageDirectory
} from "../src/index.ts"
import {
  createIntegrationValidation,
  createIntegrationDiscovery,
  discoverIntegration,
  listIntegrationOverviews,
  searchIntegrations,
  validateIntegrationNode
} from "../src/index.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) {
    await closeExecutor(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

const json = (text: string): Schema.Schema.Type<typeof Schema.Json> =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))

describe("Executor discovery SDK", () => {
  test("ignores unsupported detections when a supported surface exists", async () => {
    const discovery = createIntegrationDiscovery({
      catalog: {
        detectIntegration: async () => [
          { kind: "graphql", confidence: "high", endpoint: "https://example.test/graphql", name: "Graph", slug: "graph" },
          { kind: "mcp", confidence: "low", endpoint: "https://example.test/mcp", name: "MCP", slug: "mcp" }
        ],
        probeMcp: async () => ({
          connected: true,
          requiresAuthentication: false,
          requiresOAuth: false,
          supportsDynamicRegistration: false,
          name: "MCP",
          slug: "mcp",
          toolCount: 1,
          serverName: null,
          instructions: null
        }),
        previewOpenApi: async () => ({
          title: null,
          version: null,
          operationCount: 0,
          servers: [],
          securitySchemes: []
        })
      }
    })

    expect((await discovery.inspect("https://example.test")).detection.kind).toBe("mcp")
  })

  test("does not switch process-default storage while a host is active", async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), "wf-executor-active-"))
    const second = await mkdtemp(path.join(os.tmpdir(), "wf-executor-other-"))
    directories.push(first, second)
    setExecutorStorageDirectory(first)
    await listExecutorIntegrations()

    expect(() => setExecutorStorageDirectory(second)).toThrow(
      "while host"
    )
  })

  test("does not expose Executor's synthetic built-in integration in the catalog", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-catalog-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)

    const integrations = await listExecutorIntegrations()

    expect(integrations.some((integration) => integration.kind === "built-in")).toBe(false)
    expect(integrations.some((integration) => integration.slug === "executor")).toBe(false)
  })

  test("normalizes MCP envelopes into workflow-facing JSON", () => {
    expect(normalizeExecutorToolResult({
      structuredContent: { id: "DOC-1", title: "Typed result" },
      content: [{ type: "text", text: "fallback" }],
      isError: false
    })).toEqual({ id: "DOC-1", title: "Typed result" })

    expect(normalizeExecutorToolResult({
      content: [{
        type: "text",
        text: JSON.stringify([{ id: "DOC-2", title: "JSON text result" }])
      }],
      isError: false
    })).toEqual([{ id: "DOC-2", title: "JSON text result" }])

    expect(normalizeExecutorToolResult({
      content: [{ type: "text", text: "plain text result" }],
      isError: false
    })).toBe("plain text result")

    expect(() => normalizeExecutorToolResult({
      content: [{ type: "text", text: "permission denied" }],
      isError: true
    })).toThrow("permission denied")
  })

  test("collapses generic MCP envelope schemas to JSON", () => {
    expect(normalizeExecutorToolOutputSchema({
      type: "object",
      properties: {
        content: { type: "array" },
        structuredContent: { type: "object" },
        isError: { const: false }
      }
    })).toEqual({})
  })

  test("searches the registry and returns exact surface URLs", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url)
        if (url.pathname === "/api/search") {
          expect(url.searchParams.get("q")).toBe("linear")
          expect(url.searchParams.get("limit")).toBe("5")
          return Response.json({
            results: [{
              domain: "linear.app",
              name: "linear.app",
              description: "Project and issue tracking",
              kinds: ["mcp", "openapi"],
              url: "https://integrations.sh/linear.app/"
            }]
          })
        }
        if (url.pathname === "/api/linear.app/surface") {
          return Response.json({
            version: 3,
            domain: "linear.app",
            surfaces: [
              {
                type: "mcp",
                slug: "linear",
                name: "Linear MCP server",
                url: "https://mcp.linear.app/mcp",
                transports: ["streamable-http"]
              },
              {
                type: "http",
                slug: "linear-api",
                name: "Linear API",
                spec: "https://linear.app/openapi.json"
              }
            ]
          })
        }
        return new Response("not found", { status: 404 })
      }
    })
    servers.push(server)

    const result = await searchIntegrations(
      { q: "linear", limit: 5 },
      { registryUrl: `http://127.0.0.1:${server.port}` }
    )
    expect(result.query).toBe("linear")
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.surfaces.map((surface) => surface.discoveryUrl)).toEqual([
      "https://mcp.linear.app/mcp",
      "https://linear.app/openapi.json"
    ])
  })

  test("runs URL detection, auth discovery, and input/output schema discovery", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-discovery-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url)
        if (url.pathname !== "/openapi.json") return new Response("not found", { status: 404 })
        return Response.json({
          openapi: "3.1.0",
          info: { title: "Public Cases", version: "1.0.0" },
          servers: [{ url: `http://127.0.0.1:${server.port}` }],
          paths: {
            "/cases/{id}": {
              get: {
                operationId: "cases.get",
                parameters: [
                  {
                    name: "id",
                    in: "path",
                    required: true,
                    schema: { type: "string" }
                  }
                ],
                responses: {
                  "200": {
                    description: "Case",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          required: ["id"],
                          properties: { id: { type: "string" } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        })
      }
    })
    servers.push(server)

    const discovered = await discoverIntegration(
      `http://127.0.0.1:${server.port}/openapi.json`
    )
    expect(discovered.detection.kind).toBe("openapi")
    expect(discovered.requiresAuthentication).toBe(false)
    expect(discovered.integration.kind).toBe("openapi")
    expect(discovered.tools.map((tool) => tool.name)).toEqual(["cases.get"])
    expect(discovered.tools[0]?.inputSchema).toBeDefined()
    expect(discovered.tools[0]?.outputSchema).toBeDefined()
    expect(discovered.tools[0]?.address).toStartWith("tools.public_cases.org.default.")

    const report = await validateIntegrationNode(json(JSON.stringify({
      source: {
        kind: "executor",
        address: discovered.tools[0]?.address
      }
    })), { live: true })
    expect(report.ok).toBe(true)
  })

  test("reports connections and tool schemas the dashboard can decode", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-overview-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url)
        const baseUrl = `http://127.0.0.1:${server.port}`
        if (url.pathname === "/open.json") {
          return Response.json({
            openapi: "3.1.0",
            info: { title: "Open Docs", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
              "/docs/{id}": {
                get: {
                  operationId: "docs.get",
                  parameters: [
                    { name: "id", in: "path", required: true, schema: { type: "string" } }
                  ],
                  responses: {
                    "200": {
                      description: "Doc",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            required: ["id"],
                            properties: { id: { type: "string" }, title: { type: "string" } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          })
        }
        if (url.pathname === "/secured.json") {
          return Response.json({
            openapi: "3.1.0",
            info: { title: "Secured Docs", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {},
            components: {
              securitySchemes: { bearer: { type: "http", scheme: "bearer" } }
            },
            security: [{ bearer: [] }]
          })
        }
        return new Response("not found", { status: 404 })
      }
    })
    servers.push(server)

    await discoverIntegration(`http://127.0.0.1:${server.port}/open.json`)
    const securedDiscovery = await discoverIntegration(
      `http://127.0.0.1:${server.port}/secured.json`
    )
    expect(securedDiscovery.requiresAuthentication).toBe(true)
    expect(securedDiscovery.tools).toEqual([])

    const overviews = await listIntegrationOverviews()
    const open = overviews.find((overview) => overview.slug === "open_docs")
    const secured = overviews.find((overview) => overview.slug === "secured_docs")

    expect(open?.connections.map((connection) => connection.name)).toEqual(["default"])
    expect(open?.requiresAuthentication).toBe(false)
    expect(open?.tools.map((tool) => tool.name)).toEqual(["docs.get"])
    expect(open?.tools[0]?.connection).toBe("default")
    expect(open?.tools[0]?.inputSchema).toBeDefined()
    expect(open?.tools[0]?.outputSchema).toBeDefined()
    expect(open?.toolError).toBeUndefined()

    expect(secured?.requiresAuthentication).toBe(true)
    expect(secured?.connections).toEqual([])
    expect(secured?.tools).toEqual([])

    // The dashboard decodes the same payload the server serializes.
    const decoded = decodeIntegrationsResponse(JSON.parse(JSON.stringify({
      generatedAt: new Date().toISOString(),
      integrations: overviews
    })))
    expect(decoded.integrations.map((overview) => overview.slug)).toEqual(
      overviews.map((overview) => overview.slug)
    )
  })

  test("rejects structurally invalid workflow integration configuration", async () => {
    const report = await validateIntegrationNode(json('{"source":false}'))
    expect(report.ok).toBe(false)
    expect(report.findings[0]?.check).toBe("structural")
  })

  test("live validation uses tool summaries without loading schemas", async () => {
    const validate = createIntegrationValidation({
      tools: {
        summaries: async () => [{
          address: ExecutorToolAddress.make("tools.docs.org.default.get"),
          name: "get",
          description: "Get one doc",
          integration: "docs",
          connection: "default"
        }]
      }
    })

    const report = await validate(json(JSON.stringify({
      source: { kind: "executor", address: "tools.docs.org.default.get" }
    })), { live: true })

    expect(report.ok).toBe(true)
    expect(report.findings).toContainEqual({
      severity: "info",
      check: "catalog",
      message: "get is available"
    })
  })
})
