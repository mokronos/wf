import { Data, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  createExecutorConnection,
  describeExecutorTool,
  executeExecutorTool,
  ExecutorToolAddress,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorToolSummaries,
  removeExecutorConnection,
  discoverIntegration,
  searchIntegrations,
  validateIntegrationNode
} from "@mokronos/wfkit-executor"
import type {
  ExecutorAuthMethod,
  ExecutorIntegration,
  ExecutorTool,
  ExecutorToolSummary,
  IntegrationSearchSurface
} from "@mokronos/wfkit-executor"
import { authorizeExecutorInBrowser, openBrowser } from "./oauth.ts"

class IntegrationCliError extends Data.TaggedError("IntegrationCliError")<{
  readonly message: string
}> {}

export interface IntegrationsCliOptions {
  readonly storageDir?: string
  readonly openBrowser?: (url: string) => void | Promise<void>
}

const cliError = (message: string): IntegrationCliError =>
  new IntegrationCliError({ message })

const errorMessage = (error: Error): string => error.message

const writeStdoutLine = (text: string): Effect.Effect<void, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    }),
    catch: (error) => cliError(`Could not write output: ${String(error)}`)
  })

const inlineLimit = 800

const inline = (value: string, limit = inlineLimit): string => {
  const flattened = value.replace(/\s+/g, " ").trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}… (+${flattened.length - limit} chars)`
}

const decodeJson = (
  text: string
): Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.Json))(text),
    catch: () => cliError("Invalid JSON")
  })

/** Listings stay browsable: one flattened line per tool, with the full text
 *  reachable through `wf i schema`. */
const listingDescriptionLimit = 240
const defaultPageSize = 5
const resultDisplayLimit = 800
const schemaSummaryLimit = 400
const discoveryToolLimit = 3
const discoveryDescriptionLimit = 120
const discoverySchemaLimit = 120
const discoveryAuthLimit = 3

const verboseFlag = () => Flag.boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription("Show complete details")
)

const visibleItems = <A>(items: ReadonlyArray<A>, verbose: boolean): ReadonlyArray<A> =>
  verbose ? items : items.slice(0, defaultPageSize)

const moreHint = (shown: number, total: number): string | undefined =>
  shown < total ? `Showing ${shown} of ${total}. Rerun with --verbose for all.` : undefined

const connectionSuffix = (connection: string): string =>
  connection === "default" ? "" : ` --connection ${connection}`

const jsonOutput = (
  value: Schema.Schema.Type<typeof Schema.Json> | object,
  verbose: boolean
): string =>
  JSON.stringify(value, null, verbose ? 2 : undefined)

const boundedJsonResult = (
  result: Schema.Schema.Type<typeof Schema.Json>,
  verbose: boolean
): Schema.Schema.Type<typeof Schema.Json> => {
  if (verbose) return result
  const compact = JSON.stringify(result)
  if (compact.length <= resultDisplayLimit) return result
  return {
    truncated: true,
    characters: compact.length,
    preview: compact.slice(0, resultDisplayLimit),
    next: "Rerun with --verbose for the complete result."
  }
}

const summaryForJson = (tool: ExecutorToolSummary) => ({
  name: tool.name,
  description: inline(tool.description, listingDescriptionLimit)
})

interface ToolGroup {
  readonly integration: string
  readonly connection: string
  readonly tools: Array<ExecutorToolSummary>
}

const groupTools = (tools: ReadonlyArray<ExecutorToolSummary>): ReadonlyArray<ToolGroup> => {
  const groups = new Map<string, ToolGroup>()
  for (const tool of tools) {
    const key = `${tool.integration}/${tool.connection}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        integration: tool.integration,
        connection: tool.connection,
        tools: [tool]
      })
    } else {
      group.tools.push(tool)
    }
  }
  return [...groups.values()]
}

const formatToolGroups = (
  groups: ReadonlyArray<ToolGroup>,
  total: number,
  verbose: boolean
): string => {
  const lines: Array<string> = []
  for (const group of groups) {
    const count = group.tools.length
    lines.push(`\n${group.integration}/${group.connection}\t${count} tool${count === 1 ? "" : "s"}`)
    for (const tool of group.tools) {
      lines.push(`${tool.name}\t${inline(tool.description, listingDescriptionLimit)}${verbose ? `\t${tool.address}` : ""}`)
    }
    // The slug an agent needs next, spelled out per group: a 53-tool listing
    // scrolls its header away long before the reader reaches the bottom.
    lines.push(`next: wf i schema ${group.integration} <tool>${connectionSuffix(group.connection)}`)
  }
  const shown = groups.reduce((count, group) => count + group.tools.length, 0)
  const hint = moreHint(shown, total)
  if (hint !== undefined) lines.push(`\n${hint}`)
  return lines.join("\n").trimStart()
}

const formatToolDetail = (tool: ExecutorTool, verbose: boolean): string => {
  if (!verbose) {
    return [
      `${tool.name}\t${tool.address}`,
      inline(tool.description, listingDescriptionLimit),
      `input: ${inline(tool.inputTypeScript ?? JSON.stringify(tool.inputSchema ?? {}), schemaSummaryLimit)}`,
      `output: ${inline(tool.outputTypeScript ?? JSON.stringify(tool.outputSchema ?? {}), schemaSummaryLimit)}`,
      `next: wf i invoke ${tool.address} '<json>'`,
      "details: rerun with --verbose for complete schemas"
    ].join("\n")
  }
  const lines = [
    tool.name,
    tool.address,
    `${tool.integration}/${tool.connection}`,
    "",
    tool.description,
    "",
    `input:\n${tool.inputTypeScript ?? JSON.stringify(tool.inputSchema ?? {}, null, 2)}`,
    "",
    `output:\n${tool.outputTypeScript ?? JSON.stringify(tool.outputSchema ?? {}, null, 2)}`,
    "",
    `next: wf i invoke ${tool.address} '<json>'`
  ]
  return lines.join("\n")
}

const toolDetailResult = (tool: ExecutorTool, verbose: boolean) => verbose
  ? {
      address: tool.address,
      name: tool.name,
      description: tool.description,
      integration: tool.integration,
      connection: tool.connection,
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.inputTypeScript === undefined ? {} : { inputTypeScript: tool.inputTypeScript }),
      ...(tool.outputTypeScript === undefined ? {} : { outputTypeScript: tool.outputTypeScript })
    }
  : {
      address: tool.address,
      name: tool.name,
      description: inline(tool.description, listingDescriptionLimit),
      input: inline(tool.inputTypeScript ?? JSON.stringify(tool.inputSchema ?? {}), schemaSummaryLimit),
      output: inline(tool.outputTypeScript ?? JSON.stringify(tool.outputSchema ?? {}), schemaSummaryLimit),
      next: `wf i invoke ${tool.address} '<json>'`
    }

const connectedSummary = (
  connection: Pick<Awaited<ReturnType<typeof createExecutorConnection>>, "address" | "integration">,
  toolCount: number,
  connectionName: string
): string => [
  `Connected ${connection.address}`,
  `tools: ${toolCount}`,
  `next: wf i tools ${connection.integration}${connectionSuffix(connectionName)}`
].join("\n")

const connectedResult = (
  connection: Awaited<ReturnType<typeof createExecutorConnection>>,
  tools: ReadonlyArray<ExecutorToolSummary>,
  verbose: boolean
) => verbose
  ? { connection, tools }
  : {
      connection: { integration: connection.integration, name: connection.name, address: connection.address },
      toolCount: tools.length,
      next: `wf i tools ${connection.integration}${connectionSuffix(connection.name)}`
    }

const discoveryResult = (
  discovery: Awaited<ReturnType<typeof discoverIntegration>>,
  verbose: boolean,
  connection: string
) => verbose
  ? discovery
  : {
      url: discovery.url,
      detection: {
        kind: discovery.detection.kind,
        confidence: discovery.detection.confidence,
        name: discovery.detection.name
      },
      integration: {
        slug: discovery.integration.slug,
        name: discovery.integration.name,
        description: inline(discovery.integration.description, listingDescriptionLimit),
        kind: discovery.integration.kind
      },
      requiresAuthentication: discovery.requiresAuthentication,
      authMethods: discovery.authMethods.slice(0, discoveryAuthLimit).map((method) => ({
        template: method.template,
        kind: method.kind,
        label: method.label
      })),
      authMethodCount: discovery.authMethods.length,
      toolCount: discovery.tools.length,
      tools: discovery.tools.slice(0, discoveryToolLimit).map((tool) => ({
        name: tool.name,
        description: inline(tool.description, discoveryDescriptionLimit),
        input: inline(tool.inputTypeScript ?? JSON.stringify(tool.inputSchema ?? {}), discoverySchemaLimit),
        output: inline(tool.outputTypeScript ?? JSON.stringify(tool.outputSchema ?? {}), discoverySchemaLimit)
      })),
      next: discovery.requiresAuthentication && discovery.tools.length === 0
        ? `wf i connect ${discovery.integration.slug}${connectionSuffix(connection)}`
        : `wf i tools ${discovery.integration.slug}${connectionSuffix(connection)}`
    }

const formatDiscovery = (
  discovery: Awaited<ReturnType<typeof discoverIntegration>>,
  connection: string
): string => {
  const lines = [
    `url: ${discovery.url}`,
    `detected: ${discovery.detection.kind} (${discovery.detection.confidence})`,
    `integration: ${discovery.integration.slug}`,
    `auth: ${discovery.requiresAuthentication ? "required" : "none"}`
  ]
  if (discovery.authMethods.length > 0) {
    const methods = discovery.authMethods.slice(0, discoveryAuthLimit)
    lines.push(`auth methods: ${methods.map((method) =>
      `${method.template}:${method.kind}`
    ).join(", ")}${methods.length < discovery.authMethods.length ? ` (+${discovery.authMethods.length - methods.length} more)` : ""}`)
  }
  if (discovery.requiresAuthentication && discovery.tools.length === 0) {
    lines.push(`next: wf i connect ${discovery.integration.slug}${connectionSuffix(connection)}`)
  }
  lines.push(`tools: ${discovery.tools.length}`)
  if (discovery.tools.length > 0) {
    lines.push(`next: wf i tools ${discovery.integration.slug}${connectionSuffix(connection)}`)
  }
  return lines.join("\n")
}

const formatDiscoveryVerbose = (
  discovery: Awaited<ReturnType<typeof discoverIntegration>>,
  connection: string
): string => [
  formatDiscovery(discovery, connection),
  "",
  `detection:\n${JSON.stringify(discovery.detection, null, 2)}`,
  "",
  `integration:\n${JSON.stringify(discovery.integration, null, 2)}`,
  "",
  `${"probe" in discovery ? "probe" : "preview"}:\n${JSON.stringify("probe" in discovery ? discovery.probe : discovery.preview, null, 2)}`,
  ...discovery.tools.flatMap((tool) => ["", formatToolDetail(tool, true)])
].join("\n")

const searchSurfaceKind = (surface: IntegrationSearchSurface): string => {
  switch (surface.type) {
    case "http":
    case "openapi":
      return "openapi"
    default:
      return surface.type
  }
}

const preferredDiscoveryUrl = (surface: IntegrationSearchSurface): string | undefined => {
  switch (surface.type) {
    case "mcp":
      return surface.discoveryUrl ?? surface.url
    case "http":
    case "openapi":
      return surface.discoveryUrl ?? surface.spec ?? surface.url
    case "graphql":
    case "cli":
      return undefined
  }
}

const searchResult = (
  search: Awaited<ReturnType<typeof searchIntegrations>>,
  verbose: boolean
) => verbose
  ? search
  : {
      query: search.query,
      results: search.results.slice(0, defaultPageSize).map((result) => ({
        domain: result.domain,
        name: result.name,
        kinds: result.kinds,
        discoverUrl: result.surfaces.map(preferredDiscoveryUrl).find((url) => url !== undefined)
      })),
      ...(search.results.length > defaultPageSize
        ? {
            showing: defaultPageSize,
            total: search.results.length,
            next: "Rerun with --verbose for all."
          }
        : {})
    }

const formatSearch = (
  search: Awaited<ReturnType<typeof searchIntegrations>>,
  verbose: boolean
): string => {
  if (search.results.length === 0) return `No integrations found for "${search.query}".`

  const lines = [`query: ${search.query}`]
  const results = visibleItems(search.results, verbose)
  for (const result of results) {
    lines.push(`\n${result.domain}\t${inline(result.name, 120)}`)
    lines.push(`kinds: ${result.kinds.join(", ")}`)
    if (verbose && result.description.length > 0) lines.push(inline(result.description, 240))
    if (verbose) lines.push(`catalog: ${result.url}`)
    if (result.surfaces.length === 0) {
      if (verbose) lines.push("surfaces: none")
      continue
    }
    if (!verbose) {
      const discoveryUrl = result.surfaces.map(preferredDiscoveryUrl).find((url) => url !== undefined)
      if (discoveryUrl !== undefined) lines.push(`discover: wf i discover ${discoveryUrl}`)
    } else {
      for (const surface of result.surfaces) {
        lines.push(`  ${searchSurfaceKind(surface)}\t${surface.name}`)
        if (surface.url !== undefined) lines.push(`  url: ${surface.url}`)
        if (surface.spec !== undefined) lines.push(`  spec: ${surface.spec}`)
        if (surface.discoveryUrl !== undefined) {
          lines.push(`  discover: wf i discover ${surface.discoveryUrl}`)
        }
      }
    }
  }
  const hint = moreHint(results.length, search.results.length)
  if (hint !== undefined) lines.push(`\n${hint}`)
  return lines.join("\n")
}

const resolveIntegration = async (target: string): Promise<ExecutorIntegration> => {
  if (URL.canParse(target)) {
    const parsed = new URL(target)
    return (await discoverIntegration(parsed.toString())).integration
  }
  const integration = (await listExecutorIntegrations()).find((entry) => entry.slug === target)
  if (integration === undefined) throw new Error(`Executor integration not found: ${target}`)
  return integration
}

const selectAuthMethod = (
  integration: ExecutorIntegration,
  template: string | undefined
): ExecutorAuthMethod => {
  const selected = template === undefined
    ? integration.authMethods.find((method) => method.kind !== "none")
    : integration.authMethods.find((method) => method.template === template)
  if (selected === undefined) {
    throw new Error(
      `No matching auth method. Available: ${integration.authMethods.map((method) =>
        `${method.template}:${method.kind}`
      ).join(", ") || "none"}`
    )
  }
  return selected
}

const assertToolsTarget = async (
  integration: string,
  connection: string
): Promise<void> => {
  const integrations = await listExecutorIntegrations()
  if (!integrations.some((candidate) => candidate.slug === integration)) {
    throw new Error(`Integration not found in catalog: ${integration}`)
  }

  const connections = await listExecutorConnections()
  if (!connections.some((candidate) =>
    candidate.integration === integration && candidate.name === connection
  )) {
    throw new Error(`Integration is not connected: ${integration}/${connection}`)
  }
}

/** Accepts whatever an agent has in hand: a tool address, an integration plus a
 *  tool name, or just the tool name it read off a listing. */
const resolveToolAddress = async (
  target: string,
  tool: string | undefined,
  connection: string
): Promise<ExecutorToolAddress> => {
  if (tool === undefined && target.startsWith("tools.")) {
    return await Schema.decodeUnknownPromise(ExecutorToolAddress)(target)
  }

  if (tool !== undefined) {
    await assertToolsTarget(target, connection)
    const summaries = await listExecutorToolSummaries({ integration: target, connection })
    const match = summaries.find((summary) => summary.name === tool)
    if (match === undefined) {
      throw new Error(
        `Tool not found: ${target}/${tool}. Run wf i tools ${target} to list its tools.`
      )
    }
    return match.address
  }

  const matches = (await listExecutorToolSummaries({ connection }))
    .filter((summary) => summary.name === target)
  const [only] = matches
  if (only !== undefined && matches.length === 1) return only.address
  if (only !== undefined) {
    throw new Error(
      `Several integrations expose ${target}. Pick one: ${matches.map((match) =>
        `wf i schema ${match.integration} ${target}`
      ).join(", ")}`
    )
  }

  const integrations = await listExecutorIntegrations()
  if (integrations.some((integration) => integration.slug === target)) {
    throw new Error(
      `${target} is an integration, not a tool. Run wf i tools ${target}, then wf i schema ${target} <tool>.`
    )
  }
  throw new Error(`Tool not found: ${target}. Run wf i tools to browse tool names.`)
}

const makeDiscover = () => Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name for unauthenticated tools")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ url, connection, text, verbose }) =>
    Effect.tryPromise({
      try: () => discoverIntegration(url, { connection }),
      catch: (error) => cliError(
        `Integration discovery failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
      )
    }).pipe(
      Effect.flatMap((result) =>
        writeStdoutLine(text
          ? verbose ? formatDiscoveryVerbose(result, connection) : formatDiscovery(result, connection)
          : jsonOutput(discoveryResult(result, verbose, connection), verbose))
      )
    )
).pipe(
  Command.withDescription("Detect and register an integration")
)

const makeSearch = () => Command.make(
  "search",
  {
    query: Argument.string("query").pipe(
      Argument.withDescription("Service name, domain, or integration keyword")
    ),
    kind: Flag.choice("kind", ["mcp", "openapi", "graphql", "cli"]).pipe(
      Flag.optional,
      Flag.withDescription("Limit results to one integration kind")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(5),
      Flag.withDescription("Maximum results (default: 5, range: 1-100)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ query, kind, limit, text, verbose }) => Effect.tryPromise({
    try: () => searchIntegrations({
      q: query,
      ...(Option.isNone(kind) ? {} : { kind: kind.value }),
      limit
    }),
    catch: (error) => cliError(
      `Integration search failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
    )
  }).pipe(
    Effect.flatMap((result) => writeStdoutLine(
      text ? formatSearch(result, verbose) : jsonOutput(searchResult(result, verbose), verbose)
    ))
  )
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

const makeList = () => Command.make(
  "list",
  {
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ text, verbose }) => Effect.tryPromise({
    try: () => listExecutorIntegrations(),
    catch: (error) => cliError(`Could not list integrations: ${String(error)}`)
  }).pipe(
    Effect.flatMap((integrations) => {
      const visible = visibleItems(integrations, verbose)
      const hint = moreHint(visible.length, integrations.length)
      return writeStdoutLine(text
        ? visible.map((integration) => verbose
            ? `${integration.slug}\t${integration.kind}\t${integration.name}\t${integration.authMethods.map((method) => method.kind).join(",")}`
            : `${integration.slug}\t${integration.kind}\t${integration.name}`
          ).concat(hint === undefined ? [] : [hint]).join("\n") || "No integrations discovered."
        : jsonOutput({
            integrations: visible.map((integration) => verbose ? integration : ({
              slug: integration.slug,
              kind: integration.kind,
              name: integration.name,
              description: inline(integration.description, listingDescriptionLimit)
            })),
            ...(hint === undefined ? {} : { showing: visible.length, total: integrations.length, next: "Rerun with --verbose for all." })
          }, verbose))
    })
  )
).pipe(Command.withDescription("List Executor's persisted integration catalog"))

const makeTools = () => Command.make(
  "tools",
  {
    integration: Argument.string("integration").pipe(Argument.optional),
    integrationFlag: Flag.string("integration").pipe(
      Flag.optional,
      Flag.withDescription("Deprecated: use the positional integration argument")
    ),
    search: Flag.string("search").pipe(
      Flag.optional,
      Flag.withDescription("Only list tools whose name or description contains this text")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name (default: default)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ integration, integrationFlag, search, connection, text, verbose }) => Effect.gen(function*() {
    const positional = Option.getOrUndefined(integration)
    const flagged = Option.getOrUndefined(integrationFlag)
    if (positional !== undefined && flagged !== undefined) {
      return yield* cliError("Provide the integration either positionally or with --integration, not both")
    }
    const selected = positional ?? flagged
    if (selected !== undefined) {
      yield* Effect.tryPromise({
        try: () => assertToolsTarget(selected, connection),
        catch: (error) => cliError(error instanceof Error ? error.message : String(error))
      })
    }
    const tools = yield* Effect.tryPromise({
      try: () => listExecutorToolSummaries({
        ...(selected === undefined ? {} : { integration: selected }),
        connection
      }),
      catch: (error) => cliError(`Could not list tools: ${String(error)}`)
    })
    const term = Option.getOrUndefined(search)?.toLowerCase()
    const matching = term === undefined
      ? tools
      : tools.filter((tool) =>
        tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term)
      )
    const visible = visibleItems(matching, verbose)
    const groups = groupTools(visible)
    yield* writeStdoutLine(
      text
        ? groups.length === 0
          ? term === undefined ? "No tools available." : `No tools match "${term}".`
          : formatToolGroups(groups, matching.length, verbose)
        : jsonOutput({
          integrations: groups.map((group) => ({
            integration: group.integration,
            connection: group.connection,
            tools: verbose ? group.tools : group.tools.map(summaryForJson)
          })),
          ...(visible.length < matching.length
            ? { showing: visible.length, total: matching.length, next: "Rerun with --verbose for all." }
            : {})
        }, verbose)
    )
  })
).pipe(Command.withDescription("List tool names and descriptions per integration"))

const makeSchema = () => Command.make(
  "schema",
  {
    target: Argument.string("target").pipe(
      Argument.withDescription("Tool name, integration slug, or tool address")
    ),
    tool: Argument.string("tool").pipe(
      Argument.optional,
      Argument.withDescription("Tool name, when the first argument is an integration")
    ),
    connection: Flag.string("connection").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Connection name (default: default)")
    ),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ target, tool, connection, text, verbose }) => Effect.gen(function*() {
    const address = yield* Effect.tryPromise({
      try: () => resolveToolAddress(target, Option.getOrUndefined(tool), connection),
      catch: (error) => cliError(error instanceof Error ? errorMessage(error) : String(error))
    })
    const detail = yield* Effect.tryPromise({
      try: () => describeExecutorTool(address),
      catch: (error) => cliError(
        `Could not read tool schema: ${error instanceof Error ? errorMessage(error) : String(error)}`
      )
    })
    yield* writeStdoutLine(
      text ? formatToolDetail(detail, verbose) : jsonOutput(toolDetailResult(detail, verbose), verbose)
    )
  })
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))

const makeConnect = (options: IntegrationsCliOptions) => Command.make(
  "connect",
  {
    target: Argument.string("integration-or-url"),
    connection: Flag.string("connection").pipe(Flag.withDefault("default")),
    template: Flag.string("template").pipe(Flag.optional),
    credentialEnv: Flag.string("credential-env").pipe(
      Flag.optional,
      Flag.withDescription("Environment variable containing an API key or bearer token")
    ),
    scopes: Flag.string("scopes").pipe(Flag.optional),
    clientId: Flag.string("client-id").pipe(Flag.optional),
    clientSecretEnv: Flag.string("client-secret-env").pipe(Flag.optional),
    noOpen: Flag.boolean("no-open"),
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300)),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({
    target,
    connection,
    template,
    credentialEnv,
    scopes,
    clientId,
    clientSecretEnv,
    noOpen,
    timeout,
    text,
    verbose
  }) => Effect.tryPromise({
    try: async () => {
      const integration = await resolveIntegration(target)
      const method = selectAuthMethod(integration, Option.getOrUndefined(template))
      if (method.kind === "oauth") {
        const clientSecretName = Option.getOrUndefined(clientSecretEnv)
        const clientSecret = clientSecretName === undefined
          ? undefined
          : process.env[clientSecretName]
        if (clientSecretName !== undefined && clientSecret === undefined) {
          throw new Error(`Environment variable ${clientSecretName} is not set`)
        }
        const scopeText = Option.getOrUndefined(scopes)
        const connected = await authorizeExecutorInBrowser({
          integration: integration.slug,
          connection,
          authMethod: method,
          timeoutMs: Math.max(1, timeout) * 1000,
          ...(scopeText === undefined
            ? {}
            : { scopes: scopeText.split(/[\s,]+/).filter((scope) => scope.length > 0) }),
          ...Option.match(clientId, {
            onNone: () => ({}),
            onSome: (value) => ({ clientId: value })
          }),
          ...(clientSecret === undefined ? {} : { clientSecret }),
          open: noOpen ? () => undefined : (options.openBrowser ?? openBrowser),
          onAuthorizationUrl: (url) => console.error(`Authorize in your browser:\n${url}`)
        })
        const tools = await listExecutorToolSummaries({
          integration: integration.slug,
          connection: connected.name
        })
        return connectedResult(connected, tools, verbose)
      }
      const envName = Option.getOrUndefined(credentialEnv)
      if (envName === undefined) {
        throw new Error(`Auth method ${method.template} requires --credential-env`)
      }
      const credential = process.env[envName]
      if (credential === undefined) throw new Error(`Environment variable ${envName} is not set`)
      const connected = await createExecutorConnection({
        integration: integration.slug,
        name: connection,
        template: method.template,
        value: credential
      })
      const tools = await listExecutorToolSummaries({
        integration: integration.slug,
        connection: connected.name
      })
      return connectedResult(connected, tools, verbose)
    },
    catch: (error) => cliError(
      `Connection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
    )
  }).pipe(Effect.flatMap((result) => writeStdoutLine(
    text
      ? "tools" in result
        ? `${connectedSummary(result.connection, result.tools.length, result.connection.name)}\n${formatToolGroups(groupTools(result.tools), result.tools.length, true)}`
        : connectedSummary(result.connection, result.toolCount, result.connection.name)
      : jsonOutput(result, verbose)
  )))
).pipe(Command.withDescription("Authorize an Executor integration"))

const makeConnections = () => Command.make(
  "connections",
  {
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ text, verbose }) => Effect.tryPromise({
    try: () => listExecutorConnections(),
    catch: (error) => cliError(`Could not list connections: ${String(error)}`)
  }).pipe(
    Effect.flatMap((connections) => {
      const visible = visibleItems(connections, verbose)
      const hint = moreHint(visible.length, connections.length)
      return writeStdoutLine(text
        ? visible.map((connection) => verbose
            ? `${connection.integration}\t${connection.name}\t${connection.template}\t${connection.address}`
            : `${connection.integration}\t${connection.name}`
          ).concat(hint === undefined ? [] : [hint]).join("\n") || "No connected integrations."
        : jsonOutput({
            connections: visible.map((connection) => verbose ? connection : ({
              integration: connection.integration,
              name: connection.name
            })),
            ...(hint === undefined ? {} : { showing: visible.length, total: connections.length, next: "Rerun with --verbose for all." })
          }, verbose))
    })
  )
).pipe(Command.withDescription("List Executor connections without exposing credentials"))

const makeDisconnect = () => Command.make(
  "disconnect",
  {
    integration: Argument.string("integration"),
    connection: Flag.string("connection").pipe(Flag.withDefault("default")),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    )
  },
  ({ integration, connection, text }) => Effect.tryPromise({
    try: () => removeExecutorConnection({ integration, name: connection }),
    catch: (error) => cliError(`Disconnect failed: ${String(error)}`)
  }).pipe(Effect.flatMap(() => writeStdoutLine(
    text
      ? `Disconnected ${integration}/${connection}`
      : JSON.stringify({ disconnected: true, integration, connection }, null, 2)
  )))
).pipe(Command.withDescription("Delete an Executor connection"))

const makeInvoke = () => Command.make(
  "invoke",
  {
    address: Argument.string("tool-address"),
    input: Argument.string("json").pipe(Argument.optional),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ address, input, file, verbose }) => Effect.gen(function*() {
    const inlineInput = Option.getOrUndefined(input)
    const filePath = Option.getOrUndefined(file)
    if (inlineInput !== undefined && filePath !== undefined) {
      return yield* cliError("Provide JSON input or --file, not both")
    }
    const source = filePath === undefined
      ? inlineInput ?? "{}"
      : yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: () => cliError(`Could not read integration input: ${filePath}`)
      })
    const payload = yield* decodeJson(source)
    const result = yield* Effect.tryPromise({
      try: async () => {
        const decodedAddress = await Schema.decodeUnknownPromise(ExecutorToolAddress)(address)
        return await executeExecutorTool(decodedAddress, payload)
      },
      catch: (error) => cliError(`Invocation failed: ${String(error)}`)
    })
    yield* writeStdoutLine(jsonOutput(boundedJsonResult(result, verbose), verbose))
  })
).pipe(Command.withDescription("Invoke an Executor tool with JSON input"))

const makeValidate = () => Command.make(
  "validate",
  {
    config: Argument.string("json-or-tool-address").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    live: Flag.boolean("live"),
    text: Flag.boolean("text").pipe(
      Flag.withDescription("Print a human-readable result")
    ),
    verbose: verboseFlag()
  },
  ({ config, file, live, text, verbose }) => Effect.gen(function*() {
    const configText = Option.getOrUndefined(config)
    const filePath = Option.getOrUndefined(file)
    if ((configText === undefined) === (filePath === undefined)) {
      return yield* cliError("Provide exactly one of a JSON config or --file")
    }
    const directAddress = configText?.startsWith("tools.") === true
    let source: string
    if (filePath === undefined) {
      if (configText === undefined) return yield* cliError("Provide a JSON config")
      source = directAddress
        ? JSON.stringify({ source: { kind: "executor", address: configText } })
        : configText
    } else {
      source = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: () => cliError(`Could not read integration configuration: ${filePath}`)
      })
    }
    const node = yield* decodeJson(source)
    const report = yield* Effect.tryPromise({
      try: () => validateIntegrationNode(node, { live: live || directAddress }),
      catch: (error) => cliError(`Integration validation failed: ${String(error)}`)
    })
    const findings = visibleItems(report.findings, verbose).map((entry) => verbose ? entry : ({
      ...entry,
      message: inline(entry.message, listingDescriptionLimit)
    }))
    const hint = moreHint(findings.length, report.findings.length)
    yield* writeStdoutLine(
      text
        ? findings.map((entry) =>
            `${entry.severity}\t${entry.check}\t${entry.message}`
          ).concat(hint === undefined ? [] : [hint]).join("\n")
        : jsonOutput(verbose ? report : {
            ok: report.ok,
            findings,
            ...(hint === undefined
              ? {}
              : { showing: findings.length, total: report.findings.length, next: "Rerun with --verbose for all." })
          }, verbose)
    )
    if (!report.ok) return yield* cliError("Integration validation failed")
  })
).pipe(Command.withDescription("Validate an Executor tool address or integration config"))

export const makeIntegrationsCommand = (options: IntegrationsCliOptions = {}) =>
  Command.make("integrations").pipe(
    Command.withDescription("Discover, authorize, inspect, and invoke through Executor"),
    Command.withAlias("i"),
    Command.withSubcommands([
      makeDiscover(),
      makeSearch(),
      makeList(),
      makeTools(),
      makeSchema(),
      makeConnect(options),
      makeConnections(),
      makeDisconnect(),
      makeInvoke(),
      makeValidate()
    ])
  )
