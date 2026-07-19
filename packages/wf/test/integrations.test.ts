import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { discover, getIntegrationSurface, validateIntegrationNode } from "../src/sdk/integrations.ts"

const linearSurface = JSON.stringify({
  version: 3, domain: "linear.app", summary: "Issue tracking",
  credentials: { linear_api_key: { type: "api_key", label: "Linear API key", generateUrl: "https://linear.app/settings/api", setup: "Create a key\nThen copy it" } },
  surfaces: [
    { type: "mcp", url: "http://placeholder/mcp", slug: "linear", name: "Linear MCP", transports: ["streamable-http"], auth: { status: "required", entries: [{ use: [{ id: "linear_api_key", mechanics: { source: "http", in: "header", headerName: "Authorization", scheme: "Bearer" } }] }] } },
    { type: "graphql", url: "https://api.linear.app/graphql", spec: "https://api.linear.app/schema.graphql", slug: "linear-graphql" },
    { type: "cli", command: "linear", packages: [{ registryType: "npm", identifier: "@linear/cli" }] }
  ]
})

const json = (text: string): Schema.Schema.Type<typeof Schema.Json> => Schema.decodeUnknownSync(Schema.Json)(JSON.parse(text))

const serverFixture = () => {
  const server: ReturnType<typeof Bun.serve> = Bun.serve({ port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/api/search") return url.searchParams.get("q") === "error"
      ? new Response("bad", { status: 500 })
      : Response.json({ results: [{ domain: "linear.app", name: "Linear", description: "Issues", kinds: ["mcp", "graphql"], url: "https://linear.app" }] })
    if (url.pathname === "/api/linear.app/surface") return new Response(linearSurface.replace("http://placeholder", `http://127.0.0.1:${server.port}`), { headers: { "content-type": "application/json" } })
    if (url.pathname === "/mcp") {
      const payload = await Schema.decodeUnknownPromise(Schema.Struct({ method: Schema.String }))(await request.json())
      if (payload.method === "initialize") return Response.json({ jsonrpc: "2.0", id: 0, result: {} }, { headers: { "mcp-session-id": "test" } })
      if (payload.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (payload.method === "tools/list") return Response.json({
        jsonrpc: "2.0", id: 1,
        result: { tools: [{
          name: "create_issue",
          inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" }, priority: { type: "number" } } }
        }] }
      })
    }
    return new Response("not found", { status: 404 })
  } })
  return { server, baseUrl: `http://127.0.0.1:${server.port}` }
}

describe("integrations SDK", () => {
  test("discovers decoded results and handles input and HTTP errors", async () => {
    const fixture = serverFixture()
    try {
      await expect(discover("linear", { baseUrl: fixture.baseUrl })).resolves.toEqual({ results: [{ domain: "linear.app", name: "Linear", description: "Issues", kinds: ["mcp", "graphql"], url: "https://linear.app" }] })
      await expect(discover("  ", { baseUrl: fixture.baseUrl })).rejects.toThrow("non-empty")
      await expect(discover("error", { baseUrl: fixture.baseUrl })).rejects.toThrow()
    } finally { fixture.server.stop() }
  })

  test("gets a surface and gives useful 404 errors", async () => {
    const fixture = serverFixture()
    try {
      const surface = await getIntegrationSurface("linear.app", { baseUrl: fixture.baseUrl })
      expect(surface.credentials?.["linear_api_key"]?.label).toBe("Linear API key")
      expect(surface.surfaces?.[1]?.spec).toContain("schema.graphql")
      await expect(getIntegrationSurface("missing.app", { baseUrl: fixture.baseUrl })).rejects.toThrow("no surface document for missing.app")
    } finally { fixture.server.stop() }
  })

  test("validates structural, registry, and live MCP checks", async () => {
    const fixture = serverFixture()
    const mcp = `${fixture.baseUrl}/mcp`
    try {
      const invalid = await validateIntegrationNode(json('{"source":false}'), { baseUrl: fixture.baseUrl })
      expect(invalid.ok).toBe(false)
      expect(invalid.findings[0]?.check).toBe("structural")
      const missingAuth = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${mcp}"},"operation":"create_issue"}`), { baseUrl: fixture.baseUrl })
      expect(missingAuth.findings.some((entry) => entry.severity === "error" && entry.check === "registry")).toBe(true)
      const happy = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${mcp}"},"operation":"create_issue","auth":{"kind":"bearer","credential":"auth:LINEAR_API_KEY"}}`), { baseUrl: fixture.baseUrl })
      expect(happy.ok).toBe(true)
      const lowercaseHeader = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${mcp}"},"operation":"create_issue","auth":{"kind":"header","credential":"auth:LINEAR_API_KEY","header":"authorization","prefix":"Bearer "}}`), { baseUrl: fixture.baseUrl })
      expect(lowercaseHeader.findings.some((entry) => entry.message.includes("auth differs"))).toBe(false)
      const mismatch = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${fixture.baseUrl}/other"},"operation":"create_issue"}`), { baseUrl: fixture.baseUrl })
      expect(mismatch.findings.some((entry) => entry.severity === "warning" && entry.check === "registry")).toBe(true)
      const unknownOperation = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${mcp}"},"operation":"missing","auth":{"kind":"bearer","credential":"auth:LINEAR_API_KEY"}}`), { baseUrl: fixture.baseUrl, live: true, resolveSecret: () => "token" })
      expect(unknownOperation.ok).toBe(false)
      const sampleFailure = await validateIntegrationNode(json(`{"domain":"linear.app","source":{"kind":"mcp","url":"${mcp}"},"operation":"create_issue","auth":{"kind":"bearer","credential":"auth:LINEAR_API_KEY"}}`), { baseUrl: fixture.baseUrl, live: true, sampleInput: json('{"priority":"high"}'), resolveSecret: () => "token" })
      expect(sampleFailure.findings.some((entry) => entry.message.includes("missing required property title"))).toBe(true)
    } finally { fixture.server.stop() }
  })

  test("reports malformed source URLs as structural errors", async () => {
    const report = await validateIntegrationNode(json('{"source":{"kind":"mcp","url":"not a URL"},"operation":"create_issue"}'))

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([{ severity: "error", check: "structural", message: "invalid source URL: not a URL" }])
  })

  test("reports unreachable MCP servers as live errors", async () => {
    const fixture = serverFixture()
    try {
      const report = await validateIntegrationNode(json('{"domain":"linear.app","source":{"kind":"mcp","url":"http://127.0.0.1:1/mcp"},"operation":"create_issue"}'), { baseUrl: fixture.baseUrl, live: true })

      expect(report.ok).toBe(false)
      expect(report.findings.some((entry) => entry.severity === "error" && entry.check === "live" && entry.message.includes("MCP server unreachable"))).toBe(true)
    } finally { fixture.server.stop() }
  })
})
