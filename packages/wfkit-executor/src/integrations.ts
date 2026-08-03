import { Schema } from "effect"
import {
  addExecutorMcp,
  addExecutorOpenApi,
  createExecutorConnection,
  detectExecutorIntegration,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorTools,
  previewExecutorOpenApi,
  probeExecutorMcp
} from "./executor.ts"
import {
  ExecutorAuthMethod,
  ExecutorDetection,
  ExecutorIntegration,
  ExecutorMcpProbe,
  ExecutorOpenApiPreview,
  ExecutorTool,
  ExecutorToolAddress,
  IntegrationOverview
} from "./schemas.ts"

export const IntegrationKind = Schema.Literals(["mcp", "openapi"])
export type IntegrationKind = typeof IntegrationKind.Type

export const IntegrationSearchKind = Schema.Literals(["mcp", "openapi", "graphql", "cli"])
export type IntegrationSearchKind = typeof IntegrationSearchKind.Type

export const IntegrationSearchQuery = Schema.Struct({
  q: Schema.String,
  kind: Schema.optional(IntegrationSearchKind),
  limit: Schema.optional(Schema.Int)
})
export type IntegrationSearchQuery = typeof IntegrationSearchQuery.Type

export const IntegrationSearchSurface = Schema.Struct({
  type: Schema.Literals(["http", "openapi", "graphql", "mcp", "cli"]),
  slug: Schema.String,
  name: Schema.String,
  url: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  transports: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.String),
  discoveryUrl: Schema.optional(Schema.String)
})
export type IntegrationSearchSurface = typeof IntegrationSearchSurface.Type

export const IntegrationSearchMatch = Schema.Struct({
  domain: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kinds: Schema.Array(IntegrationSearchKind),
  url: Schema.String,
  surfaces: Schema.Array(IntegrationSearchSurface)
})
export type IntegrationSearchMatch = typeof IntegrationSearchMatch.Type

export const IntegrationSearchResponse = Schema.Struct({
  query: Schema.String,
  results: Schema.Array(IntegrationSearchMatch)
})
export type IntegrationSearchResponse = typeof IntegrationSearchResponse.Type

export interface SearchIntegrationsOptions {
  readonly registryUrl?: string
}

const integrationsRegistryUrl = "https://integrations.sh"

const RegistrySearchResponse = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    domain: Schema.String,
    name: Schema.String,
    description: Schema.String,
    kinds: Schema.Array(IntegrationSearchKind),
    url: Schema.String
  }))
})

const RegistrySurfaceResponse = Schema.Struct({
  surfaces: Schema.Array(IntegrationSearchSurface)
})

const discoveryUrlFor = (surface: IntegrationSearchSurface): string | undefined => {
  switch (surface.type) {
    case "mcp":
      return surface.url
    case "http":
    case "openapi":
      return surface.spec ?? surface.url
    case "graphql":
    case "cli":
      return undefined
  }
}

const searchSurface = async (
  registryUrl: string,
  domain: string
): Promise<ReadonlyArray<IntegrationSearchSurface>> => {
  try {
    const url = new URL(`/api/${encodeURIComponent(domain)}/surface`, registryUrl)
    const response = await fetch(url)
    if (!response.ok) return []
    const parsed = await Schema.decodeUnknownPromise(
      Schema.fromJsonString(RegistrySurfaceResponse)
    )(await response.text())
    return parsed.surfaces.map((surface) => {
      const discoveryUrl = discoveryUrlFor(surface)
      return discoveryUrl === undefined ? surface : { ...surface, discoveryUrl }
    })
  } catch {
    return []
  }
}

export const searchIntegrations = async (
  query: IntegrationSearchQuery,
  options: SearchIntegrationsOptions = {}
): Promise<IntegrationSearchResponse> => {
  const text = query.q.trim()
  if (text.length === 0) throw new Error("Integration search query cannot be empty")
  if (query.limit !== undefined && (query.limit < 1 || query.limit > 100)) {
    throw new Error("Integration search limit must be between 1 and 100")
  }

  const registryUrl = options.registryUrl ?? integrationsRegistryUrl
  const url = new URL("/api/search", registryUrl)
  url.searchParams.set("q", text)
  if (query.kind !== undefined) url.searchParams.set("kind", query.kind)
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit))

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Integration search failed: ${response.status} ${response.statusText}`)
  }
  const parsed = await Schema.decodeUnknownPromise(
    Schema.fromJsonString(RegistrySearchResponse)
  )(await response.text())
  const results = await Promise.all(parsed.results.map(async (result) => ({
    ...result,
    surfaces: await searchSurface(registryUrl, result.domain)
  })))
  return { query: text, results }
}

export const IntegrationDiscovery = Schema.Struct({
  url: Schema.String,
  detection: ExecutorDetection,
  probe: Schema.optional(ExecutorMcpProbe),
  preview: Schema.optional(ExecutorOpenApiPreview),
  integration: ExecutorIntegration,
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  tools: Schema.Array(ExecutorTool)
})
export type IntegrationDiscovery = typeof IntegrationDiscovery.Type

export interface DiscoverIntegrationsOptions {
  readonly connection?: string
}

export const IntegrationNodeConfig = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("executor"),
    address: ExecutorToolAddress
  })
})
export type IntegrationNodeConfig = typeof IntegrationNodeConfig.Type

export const IntegrationValidationFinding = Schema.Struct({
  severity: Schema.Literals(["error", "warning", "info"]),
  check: Schema.String,
  message: Schema.String
})
export type IntegrationValidationFinding = typeof IntegrationValidationFinding.Type

export const IntegrationValidationReport = Schema.Struct({
  ok: Schema.Boolean,
  findings: Schema.Array(IntegrationValidationFinding)
})
export type IntegrationValidationReport = typeof IntegrationValidationReport.Type

const confidenceRank = (confidence: ExecutorDetection["confidence"]): number => {
  switch (confidence) {
    case "high": return 3
    case "medium": return 2
    case "low": return 1
  }
}

const bestDetection = (detections: ReadonlyArray<ExecutorDetection>): ExecutorDetection | undefined =>
  [...detections].sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence))[0]

const existingIntegration = async (slug: string): Promise<ExecutorIntegration | undefined> =>
  (await listExecutorIntegrations()).find((integration) => integration.slug === slug)

const ensureConnection = async (
  integration: ExecutorIntegration,
  connectionName: string
): Promise<void> => {
  const existing = (await listExecutorConnections()).some((connection) =>
    connection.integration === integration.slug && connection.name === connectionName
  )
  if (existing) return
  const noAuth = integration.authMethods.find((method) => method.kind === "none")
  if (noAuth === undefined && integration.authMethods.length > 0) return
  await createExecutorConnection({
    integration: integration.slug,
    name: connectionName,
    template: noAuth?.template ?? "none",
    value: ""
  })
}

const detectWithFallback = async (url: string): Promise<ExecutorDetection> => {
  const detected = bestDetection(await detectExecutorIntegration(url))
  if (detected !== undefined) return detected
  try {
    const probe = await probeExecutorMcp(url)
    return {
      kind: "mcp",
      confidence: "high",
      endpoint: url,
      name: probe.name,
      slug: probe.slug
    }
  } catch {
    const preview = await previewExecutorOpenApi(url)
    const name = preview.title ?? new URL(url).hostname
    return {
      kind: "openapi",
      confidence: "high",
      endpoint: url,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    }
  }
}

export const discoverIntegration = async (
  url: string,
  options: DiscoverIntegrationsOptions = {}
): Promise<IntegrationDiscovery> => {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported integration URL protocol: ${parsed.protocol}`)
  }
  const connectionName = options.connection ?? "default"
  const detection = await detectWithFallback(parsed.toString())
  if (detection.kind === "mcp") {
    const probe = await probeExecutorMcp(detection.endpoint)
    let registered = await existingIntegration(detection.slug)
    if (registered === undefined) {
      await addExecutorMcp({
        endpoint: detection.endpoint,
        name: probe.name,
        slug: detection.slug,
        auth: probe.requiresOAuth ? "oauth2" : probe.requiresAuthentication ? "bearer" : "none"
      })
      registered = await existingIntegration(detection.slug)
    }
    if (registered === undefined) throw new Error(`Executor did not persist MCP integration ${detection.slug}`)
    await ensureConnection(registered, connectionName)
    return {
      url: parsed.toString(),
      detection,
      probe,
      integration: registered,
      requiresAuthentication:
        registered.authMethods.length > 0 &&
        !registered.authMethods.some((method) => method.kind === "none"),
      authMethods: registered.authMethods,
      tools: await listExecutorTools({ integration: registered.slug, connection: connectionName })
    }
  }
  if (detection.kind !== "openapi") {
    throw new Error(`Executor detected unsupported integration kind: ${detection.kind}`)
  }
  const preview = await previewExecutorOpenApi(detection.endpoint)
  let registered = await existingIntegration(detection.slug)
  if (registered === undefined) {
    await addExecutorOpenApi({
      spec: detection.endpoint,
      slug: detection.slug,
      name: detection.name,
      ...(preview.servers[0]?.url === undefined ? {} : { baseUrl: preview.servers[0].url })
    })
    registered = await existingIntegration(detection.slug)
  }
  if (registered === undefined) throw new Error(`Executor did not persist OpenAPI integration ${detection.slug}`)
  await ensureConnection(registered, connectionName)
  return {
    url: parsed.toString(),
    detection,
    preview,
    integration: registered,
    requiresAuthentication:
      registered.authMethods.length > 0 &&
      !registered.authMethods.some((method) => method.kind === "none"),
    authMethods: registered.authMethods,
    tools: await listExecutorTools({ integration: registered.slug, connection: connectionName })
  }
}

const toolsForConnection = async (
  integration: string,
  connection: string
): Promise<{ readonly tools: ReadonlyArray<ExecutorTool>; readonly error?: string }> => {
  try {
    return { tools: await listExecutorTools({ integration, connection }) }
  } catch (cause) {
    return {
      tools: [],
      error: `${connection}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
}

/** The full picture of what is connected: every catalog integration with its
 *  connections and the tools each connection exposes. Listing tools reaches the
 *  live endpoint, so a failing integration reports `toolError` instead of
 *  failing the whole overview. */
export const listIntegrationOverviews = async (): Promise<ReadonlyArray<IntegrationOverview>> => {
  const [integrations, connections] = await Promise.all([
    listExecutorIntegrations(),
    listExecutorConnections()
  ])
  const overviews = await Promise.all(integrations.map(async (integration) => {
    const owned = connections.filter((connection) => connection.integration === integration.slug)
    const listings = await Promise.all(owned.map((connection) =>
      toolsForConnection(integration.slug, connection.name)
    ))
    const errors = listings.flatMap((listing) => listing.error === undefined ? [] : [listing.error])
    const tools = listings
      .flatMap((listing) => listing.tools)
      .toSorted((left, right) => left.name.localeCompare(right.name))
    return {
      slug: integration.slug,
      name: integration.name,
      description: integration.description,
      kind: integration.kind,
      ...(integration.displayUrl === undefined ? {} : { displayUrl: integration.displayUrl }),
      requiresAuthentication: integration.authMethods.length > 0 &&
        !integration.authMethods.some((method) => method.kind === "none"),
      authMethods: integration.authMethods,
      connections: owned,
      tools,
      ...(errors.length === 0 ? {} : { toolError: errors.join("; ") })
    }
  }))
  return overviews.toSorted((left, right) => left.name.localeCompare(right.name))
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

export const validateIntegrationNode = async (
  config: Schema.Schema.Type<typeof Schema.Json>,
  options: { readonly live?: boolean } = {}
): Promise<IntegrationValidationReport> => {
  let node: IntegrationNodeConfig
  try {
    node = await Schema.decodeUnknownPromise(IntegrationNodeConfig)(config)
  } catch (error) {
    return {
      ok: false,
      findings: [finding("error", "structural", `invalid integration node: ${String(error)}`)]
    }
  }
  const findings: Array<IntegrationValidationFinding> = [
    finding("info", "structural", "Executor tool address is valid")
  ]
  if (options.live === true) {
    const tool = (await listExecutorTools()).find((candidate) =>
      candidate.address === node.source.address
    )
    if (tool === undefined) {
      findings.push(finding("error", "catalog", `Executor tool not found: ${node.source.address}`))
    } else {
      findings.push(finding("info", "catalog", `${tool.name} is available`))
    }
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  }
}
