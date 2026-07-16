import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { auth, defineWorkflow, integration, t } from "../src/index.ts"

const runningServers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of runningServers.splice(0)) server.stop(true)
})

const startServer = (fetch: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ port: 0, fetch })
  runningServers.push(server)
  return `http://127.0.0.1:${server.port}`
}

const secretResolver = (values: Readonly<Record<string, string>>) => ({
  resolve: (name: string): string => {
    const value = values[name]
    if (value === undefined) throw new Error(`Missing test secret: ${name}`)
    return value
  }
})

describe("integration node", () => {
  test("calls an OpenAPI-style endpoint with an API key outside workflow input", async () => {
    const baseUrl = startServer(async (request) => {
      expect(request.headers.get("x-api-key")).toBe("api-secret")
      expect(await request.json()).toEqual({ title: "A durable issue" })
      return Response.json({ id: "ISS-1", title: "A durable issue" })
    })

    const CreateIssueOutput = t.struct({ id: t.string, title: t.string })
    const createIssue = integration({
      source: { kind: "openapi", url: baseUrl, method: "POST", path: "/issues" },
      operation: "createIssue",
      auth: { kind: "api-key", credential: auth("issues-api") },
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput
    })
    const workflow = defineWorkflow({
      name: "OpenApiIntegrationTest",
      version: 1,
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput,
      run: function* (input, ctx) {
        return yield* ctx.run(createIssue, input)
      }
    })

    const result = await workflow.executeInMemory(
      { title: "A durable issue" },
      { secrets: secretResolver({ "issues-api": "api-secret" }) }
    )
    expect(result).toEqual({ id: "ISS-1", title: "A durable issue" })
  })

  test("calls an MCP tool with bearer auth and validates its result", async () => {
    const RequestBody = Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optional(Schema.Number),
      method: Schema.String,
      params: Schema.optional(Schema.Json)
    })
    let initialized = false
    const baseUrl = startServer(async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer oauth-token")
      const payload = Schema.decodeUnknownSync(RequestBody)(await request.json())
      if (payload.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-linear", version: "1.0.0" }
          }
        }, { headers: { "mcp-session-id": "test-session" } })
      }
      expect(request.headers.get("mcp-session-id")).toBe("test-session")
      if (payload.method === "notifications/initialized") {
        initialized = true
        return new Response(null, { status: 202 })
      }
      expect(initialized).toBe(true)
      const ToolCallParams = Schema.Struct({ name: Schema.String, arguments: Schema.Json })
      const params = Schema.decodeUnknownSync(ToolCallParams)(payload.params)
      expect(params.name).toBe("create_issue")
      expect(params.arguments).toEqual({ title: "From MCP" })
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id ?? 1,
        result: {
          content: [{ type: "text", text: "Created MCP-1" }],
          structuredContent: { id: "MCP-1", title: "From MCP" }
        }
      })
    })

    const CreateIssueOutput = t.struct({ id: t.string, title: t.string })
    const createIssue = integration({
      source: { kind: "mcp", url: baseUrl },
      operation: "create_issue",
      auth: { kind: "bearer", credential: auth("linear-oauth") },
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput
    })
    const workflow = defineWorkflow({
      name: "McpIntegrationTest",
      version: 1,
      input: t.struct({ title: t.string }),
      output: CreateIssueOutput,
      run: function* (input, ctx) {
        return yield* ctx.run(createIssue, input)
      }
    })

    const result = await workflow.executeInMemory(
      { title: "From MCP" },
      { secrets: secretResolver({ "linear-oauth": "oauth-token" }) }
    )
    expect(result).toEqual({ id: "MCP-1", title: "From MCP" })
  })
})
