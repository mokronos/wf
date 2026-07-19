import { Schema } from "effect"
import { envSecretResolver } from "../core.ts"
import { AuthRef, listMcpTools, resolveAuthorizationHeaders } from "../integration.ts"

export const IntegrationKind = Schema.Union([Schema.Literal("mcp"), Schema.Literal("openapi"), Schema.Literal("graphql"), Schema.Literal("cli")])
export type IntegrationKind = typeof IntegrationKind.Type

export interface DiscoverIntegrationsOptions {
  readonly kind?: IntegrationKind
  readonly limit?: number
  readonly baseUrl?: string
}

export const IntegrationSearchResult = Schema.Struct({ domain: Schema.String, name: Schema.String, description: Schema.String, kinds: Schema.Array(IntegrationKind), url: Schema.String })
export type IntegrationSearchResult = typeof IntegrationSearchResult.Type
export const DiscoverIntegrationsResult = Schema.Struct({ results: Schema.Array(IntegrationSearchResult) })
export type DiscoverIntegrationsResult = typeof DiscoverIntegrationsResult.Type

const SurfaceMechanics = Schema.Struct({ source: Schema.optional(Schema.Union([Schema.Literal("http"), Schema.Literal("well-known")])), in: Schema.optional(Schema.String), headerName: Schema.optional(Schema.String), scheme: Schema.optional(Schema.String) })
const SurfaceAuthUse = Schema.Struct({ id: Schema.String, mechanics: Schema.optional(SurfaceMechanics) })
export const IntegrationSurfaceAuth = Schema.Struct({ status: Schema.optional(Schema.Union([Schema.Literal("required"), Schema.Literal("none"), Schema.Literal("unknown")])), entries: Schema.optional(Schema.Array(Schema.Struct({ use: Schema.optional(Schema.Array(SurfaceAuthUse)) }))) })
export const IntegrationSurfaceCredential = Schema.Struct({ type: Schema.optional(Schema.String), label: Schema.optional(Schema.String), generateUrl: Schema.optional(Schema.String), setup: Schema.optional(Schema.String) })
export const IntegrationSurface = Schema.Struct({ type: Schema.String, url: Schema.optional(Schema.String), spec: Schema.optional(Schema.String), slug: Schema.optional(Schema.String), name: Schema.optional(Schema.String), docs: Schema.optional(Schema.String), transports: Schema.optional(Schema.Array(Schema.String)), packages: Schema.optional(Schema.Array(Schema.Struct({ registryType: Schema.optional(Schema.String), identifier: Schema.optional(Schema.String) }))), command: Schema.optional(Schema.String), auth: Schema.optional(IntegrationSurfaceAuth) })
export const IntegrationSurfaceDocument = Schema.Struct({ version: Schema.Number, domain: Schema.String, summary: Schema.optional(Schema.String), description: Schema.optional(Schema.String), discoveredAt: Schema.optional(Schema.String), credentials: Schema.optional(Schema.Record(Schema.String, IntegrationSurfaceCredential)), surfaces: Schema.optional(Schema.Array(IntegrationSurface)) })
export type IntegrationSurfaceDocument = typeof IntegrationSurfaceDocument.Type

const IntegrationNodeAuth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bearer"), credential: AuthRef }),
  Schema.Struct({ kind: Schema.Literal("api-key"), credential: AuthRef, header: Schema.optional(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("header"), credential: AuthRef, header: Schema.String, prefix: Schema.optional(Schema.String) })
])
export const IntegrationNodeConfig = Schema.Struct({
  domain: Schema.optional(Schema.String),
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("mcp"), url: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("openapi"), url: Schema.String, method: Schema.Union([Schema.Literal("GET"), Schema.Literal("POST"), Schema.Literal("PUT"), Schema.Literal("PATCH"), Schema.Literal("DELETE")]), path: Schema.optional(Schema.String) })
  ]), operation: Schema.String, auth: Schema.optional(IntegrationNodeAuth)
})
export type IntegrationNodeConfig = typeof IntegrationNodeConfig.Type
export const IntegrationValidationFinding = Schema.Struct({ severity: Schema.Union([Schema.Literal("error"), Schema.Literal("warning"), Schema.Literal("info")]), check: Schema.String, message: Schema.String })
export type IntegrationValidationFinding = typeof IntegrationValidationFinding.Type
export const IntegrationValidationReport = Schema.Struct({ ok: Schema.Boolean, findings: Schema.Array(IntegrationValidationFinding) })
export type IntegrationValidationReport = typeof IntegrationValidationReport.Type

export const discover = async (
  searchTerm: string,
  options: DiscoverIntegrationsOptions = {}
): Promise<DiscoverIntegrationsResult> => {
  const query = searchTerm.trim()

  if (query.length === 0) {
    throw new Error("discover requires a non-empty search term")
  }

  const url = new URL("/api/search", options.baseUrl ?? "https://integrations.sh")
  url.searchParams.set("q", query)

  if (options.kind !== undefined) {
    url.searchParams.set("kind", options.kind)
  }

  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit))
  }

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`integrations.sh discover failed: ${response.status} ${response.statusText}`)
  }

  return await Schema.decodeUnknownPromise(DiscoverIntegrationsResult)(await response.json())
}

export const getIntegrationSurface = async (domain: string, options: { readonly baseUrl?: string } = {}): Promise<IntegrationSurfaceDocument> => {
  const url = new URL(`/api/${encodeURIComponent(domain)}/surface`, options.baseUrl ?? "https://integrations.sh")
  const response = await fetch(url)
  if (response.status === 404) throw new Error(`no surface document for ${domain}`)
  if (!response.ok) throw new Error(`integrations.sh surface failed: ${response.status} ${response.statusText}`)
  return await Schema.decodeUnknownPromise(IntegrationSurfaceDocument)(await response.json())
}

const normalizedUrl = (url: string): string => url.replace(/\/+$/, "")
const finding = (severity: IntegrationValidationFinding["severity"], check: string, message: string): IntegrationValidationFinding => ({ severity, check, message })
const firstMechanics = (surface: typeof IntegrationSurface.Type): typeof SurfaceMechanics.Type | undefined => surface.auth?.entries?.[0]?.use?.[0]?.mechanics
const authPlausible = (auth: typeof IntegrationNodeAuth.Type, mechanics: typeof SurfaceMechanics.Type): boolean =>
  mechanics.headerName === undefined || (auth.kind === "bearer" && mechanics.scheme === "Bearer") ||
  (auth.kind === "header" && auth.header.toLowerCase() === mechanics.headerName.toLowerCase() && (mechanics.scheme === undefined || auth.prefix === mechanics.scheme + " ")) ||
  (auth.kind === "api-key" && (auth.header ?? "x-api-key").toLowerCase() === mechanics.headerName.toLowerCase())

const ShallowInputSchema = Schema.Struct({ required: Schema.optional(Schema.Array(Schema.String)), properties: Schema.optional(Schema.Record(Schema.String, Schema.Struct({ type: Schema.optional(Schema.String) }))) })
const JsonObject = Schema.Record(Schema.String, Schema.Json)

const shallowInputFindings = async (inputSchema: Schema.Schema.Type<typeof Schema.Json> | undefined, sampleInput: Schema.Schema.Type<typeof Schema.Json>): Promise<ReadonlyArray<IntegrationValidationFinding>> => {
  if (inputSchema === undefined) return []
  let schema: typeof ShallowInputSchema.Type
  let input: typeof JsonObject.Type
  try {
    schema = await Schema.decodeUnknownPromise(ShallowInputSchema)(inputSchema)
    input = await Schema.decodeUnknownPromise(JsonObject)(sampleInput)
  } catch { return [] }
  const required = schema.required ?? []
  const missing = required.filter((key) => input[key] === undefined)
  const requiredFindings = missing.map((key) => finding("error", "live", `sample input is missing required property ${key}`))
  const typeFindings = Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
    const value = input[key]
    if (value === undefined || property.type === undefined) return []
    const actual = Array.isArray(value) ? "array" : typeof value
    return actual === property.type ? [] : [finding("warning", "live", `sample input property ${key} is ${actual}; expected ${property.type}`)]
  })
  return [...requiredFindings, ...typeFindings]
}

export const validateIntegrationNode = async (config: Schema.Schema.Type<typeof Schema.Json>, options: {
  readonly baseUrl?: string
  readonly live?: boolean
  readonly sampleInput?: Schema.Schema.Type<typeof Schema.Json>
  readonly resolveSecret?: (name: string) => string | Promise<string>
} = {}): Promise<IntegrationValidationReport> => {
  let node: IntegrationNodeConfig
  try { node = await Schema.decodeUnknownPromise(IntegrationNodeConfig)(config) } catch (error) {
    return { ok: false, findings: [finding("error", "structural", `invalid integration node: ${String(error)}`)] }
  }
  let sourceUrl: URL
  try { sourceUrl = new URL(node.source.url) } catch {
    return { ok: false, findings: [finding("error", "structural", `invalid source URL: ${node.source.url}`)] }
  }
  const findings: Array<IntegrationValidationFinding> = [finding("info", "structural", "configuration is valid")]
  const domain = node.domain ?? sourceUrl.hostname
  let surfaceDocument: IntegrationSurfaceDocument | undefined
  try { surfaceDocument = await getIntegrationSurface(domain, options) } catch (error) {
    if (error instanceof Error && error.message === `no surface document for ${domain}`) findings.push(finding("warning", "registry", error.message))
    else throw error
  }
  if (surfaceDocument !== undefined) {
    const expectedType = node.source.kind === "openapi" ? "http" : "mcp"
    const candidates = (surfaceDocument.surfaces ?? []).filter((surface) => surface.type === expectedType)
    const matched = candidates.find((surface) => surface.url !== undefined && normalizedUrl(surface.url) === normalizedUrl(node.source.url))
    if (matched === undefined) findings.push(finding("warning", "registry", `source URL is not registered; known ${expectedType} URLs: ${candidates.map((surface) => surface.url ?? "(none)").join(", ") || "none"}`))
    else {
      if (matched.auth?.status === "required" && node.auth === undefined) findings.push(finding("error", "registry", "registry surface requires auth but config has no auth"))
      const mechanics = firstMechanics(matched)
      if (node.auth !== undefined && mechanics !== undefined && !authPlausible(node.auth, mechanics)) findings.push(finding("warning", "registry", `auth differs from expected mechanics: ${mechanics.headerName ?? "header"}${mechanics.scheme === undefined ? "" : ` ${mechanics.scheme}`}`))
      else findings.push(finding("info", "registry", `matches registry surface ${matched.slug ?? matched.name ?? matched.type}`))
    }
  }
  if (options.live === true && node.source.kind === "mcp") {
    let headers: Record<string, string> = {}
    let credentialsUnavailable = false
    try { headers = await resolveAuthorizationHeaders(node.auth, async (name) => await (options.resolveSecret ?? envSecretResolver().resolve)(name)) } catch (error) {
      credentialsUnavailable = true
      findings.push(finding("warning", "live", `live check needs credentials: ${String(error)}`))
    }
    try {
      const tools = await listMcpTools(node.source.url, headers)
      const tool = tools.find((entry) => entry.name === node.operation)
      if (tool === undefined) findings.push(finding("error", "live", `operation ${node.operation} not found; available tools: ${tools.map((entry) => entry.name).join(", ")}`))
      else {
        findings.push(finding("info", "live", `operation ${node.operation} is available`))
        if (options.sampleInput !== undefined) findings.push(...await shallowInputFindings(tool.inputSchema, options.sampleInput))
      }
    } catch (error) {
      const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined
      if ((status === 401 || status === 403) && (node.auth === undefined || credentialsUnavailable)) findings.push(finding("warning", "live", "live check needs credentials"))
      else if (status === undefined) findings.push(finding("error", "live", `MCP server unreachable: ${String(error)}`))
      else findings.push(finding("error", "live", String(error)))
    }
  }
  return { ok: !findings.some((entry) => entry.severity === "error"), findings }
}
