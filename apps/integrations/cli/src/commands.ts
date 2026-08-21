import { whenPresent, whenPresentMap } from "./optional.ts"
import { Effect, Option, Predicate, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { generateModule } from "@mokronos/integrations-client"
import type { GatewayClient, GrantedTool } from "@mokronos/integrations-client"
import { cliError, connectToGateway, describeError, openBrowser } from "./connection.ts"
import type { IntegrationsCliError } from "./connection.ts"
import {
  inline,
  jsonOutput,
  page,
  pageFields,
  withNext,
  writeStdoutLine
} from "./output.ts"
import type { Page, Window } from "./output.ts"

const verboseFlag = () =>
  Flag.boolean("verbose").pipe(
    Flag.withAlias("v"),
    // Says how much of each row to show. It does not say how many rows: a
    // listing returns all of them either way, so nothing is hidden behind a
    // flag the reader did not know to pass.
    Flag.withDescription("Show complete objects, pretty-printed")
  )

const limitFlag = () =>
  Flag.integer("limit").pipe(
    Flag.optional,
    Flag.withDescription("Return at most this many rows (default: all of them)")
  )

const offsetFlag = () =>
  Flag.integer("offset").pipe(
    Flag.optional,
    Flag.withDescription("Skip this many rows. Listings are ordered, so a window is stable")
  )

const connectionFlag = () =>
  Flag.string("connection").pipe(
    Flag.withDefault("default"),
    Flag.withDescription("Connection name (default: default)")
  )

const window = (
  limit: Option.Option<number>,
  offset: Option.Option<number>
): Window => ({
  limit: Option.getOrUndefined(limit),
  offset: Option.getOrUndefined(offset)
})

const gatewayTask = <A>(
  task: (client: GatewayClient) => Promise<A>
): Effect.Effect<A, IntegrationsCliError> =>
  Effect.tryPromise({
    try: async () => await task(await connectToGateway()),
    catch: (error) => cliError(describeError(error))
  })

const JsonObject = Schema.Record(Schema.String, Schema.Json)
const JsonArray = Schema.Array(Schema.Json)
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** The gateway's responses arrive as unparsed JSON. These decode a response into
 *  a usable value and fall back to empty rather than failing the command: a
 *  listing that renders nothing is easier for a reader to act on than a crash,
 *  and the gateway is the party responsible for its own response shape. */
const record = (value: typeof Schema.Json.Type | undefined): Record<string, typeof Schema.Json.Type> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonObject)(value), () => ({}))

const array = (value: typeof Schema.Json.Type | undefined): ReadonlyArray<Record<string, typeof Schema.Json.Type>> =>
  Option.getOrElse(Schema.decodeUnknownOption(JsonArray)(value), () => []).map(record)

const text = (value: Schema.Json | undefined): string => value === undefined || value === null ? "" : String(value)

/** Listings are ordered before they are windowed. An offset into an unordered
 *  result addresses different rows on every call, which makes paging worse than
 *  no paging. */
const sortedBy = <A>(
  items: ReadonlyArray<A>,
  key: (item: A) => string
): ReadonlyArray<A> => [...items].sort((left, right) => key(left).localeCompare(key(right)))

const readJsonArgument = async (
  inline_: string | undefined,
  file: string | undefined
): Promise<typeof Schema.Json.Type> => {
  if (inline_ !== undefined && file !== undefined) {
    throw cliError("Provide JSON input or --file, not both")
  }
  const source = file === undefined ? inline_ ?? "{}" : await Bun.file(file).text()
  try {
    return decodeJsonText(source)
  } catch (error) {
    throw cliError(
      `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** Prints a listing. Keeping this in one place is what makes `count`, the
 *  window fields, and the hint behave the same on every listing. */
const listing = <A>(
  result: Page<A>,
  options: {
    readonly key: string
    readonly narrowing: string
    readonly verbose: boolean
    readonly row: (item: A) => typeof Schema.Json.Type
    readonly empty: string
    readonly next?: string
    readonly extra?: Record<string, typeof Schema.Json.Type>
  }
): Effect.Effect<void> =>
  writeStdoutLine(jsonOutput(
    withNext({
      ...options.extra,
      [options.key]: result.items.map(options.row),
      ...pageFields(result, options.narrowing)
    }, options.next),
    options.verbose
  ))

// --- catalog ----------------------------------------------------------------

const discoverCommand = Command.make(
  "discover",
  {
    url: Argument.string("url").pipe(
      Argument.withDescription("MCP endpoint or OpenAPI document URL")
    ),
    connection: connectionFlag(),
    verbose: verboseFlag()
  },
  ({ url, connection, verbose }) =>
    gatewayTask((client) => client.request("POST", "/v1/integrations/discover", { url, connection }))
      .pipe(Effect.flatMap((result) => {
        const body = record(result)
        const integration = record(body["integration"])
        const tools = array(body["tools"])
        const slug = text(integration["slug"])
        return writeStdoutLine(jsonOutput(
          withNext(
            verbose ? body : { integration, toolCount: tools.length },
            `integrations connect ${slug}`
          ),
          verbose
        ))
      }))
).pipe(Command.withDescription("Detect and register an integration"))

const searchCommand = Command.make(
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
      // Not a window over a local listing: this one is asked of the registry,
      // which ranks by relevance. Reordering it here would throw that away.
      Flag.withDescription("How many results to ask the registry for (default: 5)")
    ),
    verbose: verboseFlag()
  },
  ({ query, kind, limit, verbose }) =>
    gatewayTask((client) => {
      const parameters = new URLSearchParams({ q: query, limit: String(limit) })
      if (Option.isSome(kind)) parameters.set("kind", kind.value)
      return client.request("GET", `/v1/registry/search?${parameters.toString()}`)
    }).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const results = array(body["results"])
      return writeStdoutLine(jsonOutput(
        withNext({ ...body, count: results.length }, "integrations discover <url>"),
        verbose
      ))
    }))
).pipe(Command.withDescription("Search integrations.sh for exact integration URLs"))

const integrationsCommand = Command.make(
  "integrations",
  {
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ limit, offset, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/integrations")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["integrations"]), (entry) => text(entry["slug"]))
        return listing(page(all, window(limit, offset)), {
          key: "integrations",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No integrations discovered.",
          next: "integrations tools <integration>",
          row: (integration) =>
            verbose ? integration : {
              slug: integration["slug"] ?? null,
              kind: integration["kind"] ?? null,
              name: integration["name"] ?? null,
              connections: array(integration["connections"]).length
            }
        })
      })
    )
).pipe(
  Command.withAlias("list"),
  Command.withDescription("List the gateway's persisted integration catalog")
)

const toolsCommand = Command.make(
  "tools",
  {
    integration: Argument.string("integration"),
    filter: Flag.string("filter").pipe(
      Flag.optional,
      Flag.withDescription("Only list tools whose name or description contains this text")
    ),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ integration, filter, limit, offset, verbose }) =>
    gatewayTask((client) =>
      client.request("GET", `/v1/integrations/${encodeURIComponent(integration)}/tools`)
    ).pipe(Effect.flatMap((result) => {
      const term = Option.getOrUndefined(filter)?.toLowerCase()
      const all = array(record(result)["tools"])
      const matching = term === undefined
        ? all
        : all.filter((tool) =>
          text(tool["name"]).toLowerCase().includes(term) ||
          text(tool["description"]).toLowerCase().includes(term)
        )
      return listing(
        page(sortedBy(matching, (tool) => text(tool["name"])), window(limit, offset)),
        {
          key: "tools",
          narrowing: "narrow with --filter <text>, or window with --limit/--offset",
          verbose,
          empty: term === undefined ? "No tools available." : `No tools match "${term}".`,
          next: `integrations schema ${integration} <tool>`,
          extra: { integration },
          row: (tool) =>
            verbose ? tool : {
              name: tool["name"] ?? null,
              description: inline(text(tool["description"]), 200)
            }
        }
      )
    }))
).pipe(Command.withDescription("List tool names and descriptions for an integration"))

const schemaCommand = Command.make(
  "schema",
  {
    integration: Argument.string("integration"),
    tool: Argument.string("tool"),
    connection: connectionFlag(),
    verbose: verboseFlag()
  },
  ({ integration, tool, connection, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "GET",
        `/v1/integrations/${encodeURIComponent(integration)}/tools/${encodeURIComponent(tool)}?connection=${
          encodeURIComponent(connection)
        }`
      )
    ).pipe(Effect.flatMap((result) => {
      const detail = record(result)
      // Schemas stay objects, whole, at both verbosities. They are the reason
      // to run this command, and a schema handed back as a truncated string
      // has to be re-fetched before it can be used for anything.
      const core = Object.fromEntries(
        Object.entries(detail).filter(([key]) =>
          key !== "inputTypeScript" && key !== "outputTypeScript"
        )
      )
      return writeStdoutLine(jsonOutput(
        withNext(
          verbose ? detail : core,
          `integrations execute --direct ${text(detail["address"])} '<json>'`
        ),
        verbose
      ))
    }))
).pipe(Command.withDescription("Show one tool's description and input/output schemas"))

// --- connections ------------------------------------------------------------

const environmentValue = (name: string): string => {
  const value = process.env[name]
  if (value === undefined) throw cliError(`Environment variable ${name} is not set`)
  return value
}

const credentialValues = (
  credentialEnv: string | undefined,
  credentialValuesFlag: string | undefined
): Record<string, string> => {
  if (credentialValuesFlag !== undefined) {
    return Object.fromEntries(credentialValuesFlag.split(",").map((pair) => {
      const [variable, name] = pair.split("=")
      if (variable === undefined || name === undefined) {
        throw cliError(`--credential-values expects VARIABLE=ENV_NAME pairs, got "${pair}"`)
      }
      return [variable.trim(), environmentValue(name.trim())]
    }))
  }
  // Credentials are read from the caller's environment here, never by the
  // gateway — the gateway has no business reading a client's process.
  return credentialEnv === undefined ? {} : { token: environmentValue(credentialEnv) }
}

const connectCommand = Command.make(
  "connect",
  {
    integration: Argument.string("integration"),
    connection: connectionFlag(),
    template: Flag.string("template").pipe(Flag.optional),
    credentialEnv: Flag.string("credential-env").pipe(
      Flag.optional,
      Flag.withDescription("Environment variable containing an API key or bearer token")
    ),
    credentialValues: Flag.string("credential-values").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated VARIABLE=ENV_NAME mappings for multi-value auth")
    ),
    clientId: Flag.string("client-id").pipe(Flag.optional),
    clientSecretEnv: Flag.string("client-secret-env").pipe(Flag.optional),
    noOpen: Flag.boolean("no-open"),
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300)),
    verbose: verboseFlag()
  },
  (options) =>
    gatewayTask(async (client) => {
      const catalog = record(await client.request("GET", "/v1/integrations"))
      const integration = array(catalog["integrations"]).find((candidate) =>
        text(candidate["slug"]) === options.integration
      )
      if (integration === undefined) {
        throw cliError(
          `Unknown integration ${options.integration}. Run: integrations discover <url>`
        )
      }
      const methods = array(integration["authMethods"])
      const template = Option.getOrUndefined(options.template)
      const credentialsOffered = Option.isSome(options.credentialEnv) ||
        Option.isSome(options.credentialValues)
      const oauthMethod = methods.find((method) =>
        text(method["kind"]) === "oauth" &&
        (template === undefined || text(method["template"]) === template)
      )

      if (oauthMethod !== undefined && credentialsOffered && template === undefined) {
        // Silently ignoring the credential and opening a browser is the worst
        // of both: the caller thinks it authorized with the key it named.
        const alternatives = methods.filter((method) => text(method["kind"]) !== "oauth")
        throw cliError(
          alternatives.length === 0
            ? `${options.integration} only supports OAuth, so --credential-env cannot be used. Drop it and authorize in a browser.`
            : `${options.integration} supports OAuth and ${
              alternatives.map((method) => text(method["template"])).join(", ")
            }. Name the one you mean with --template.`
        )
      }

      if (oauthMethod !== undefined) {
        const secretName = Option.getOrUndefined(options.clientSecretEnv)
        const started = record(await client.request("POST", "/v1/connections/oauth", {
          integration: options.integration,
          connection: options.connection,
          ...whenPresent("template", template),
          ...Option.match(options.clientId, {
            onNone: () => ({}),
            onSome: (value) => ({ clientId: value })
          }),
          ...whenPresentMap("clientSecret", secretName, environmentValue),
          timeoutSeconds: options.timeout
        }))
        const sessionId = text(started["id"])
        const state = record(started["state"])
        const authorizationUrl = text(state["authorizationUrl"])
        if (text(state["status"]) === "pending" && authorizationUrl.length > 0) {
          console.error(`Authorize in your browser:\n${authorizationUrl}`)
          if (!options.noOpen) openBrowser(authorizationUrl)
        }
        // Poll rather than block on a socket: the gateway owns the flow, and a
        // human may take minutes.
        const deadline = Date.now() + Math.max(1, options.timeout) * 1000
        while (Date.now() < deadline) {
          const session = record(await client.request("GET", `/v1/connections/oauth/${sessionId}`))
          const current = record(session["state"])
          if (text(current["status"]) === "connected") return record(current["connection"])
          if (text(current["status"]) === "failed") {
            throw cliError(`Connection failed: ${text(current["message"])}`)
          }
          await Bun.sleep(500)
        }
        throw cliError(`OAuth authorization timed out after ${options.timeout} seconds`)
      }

      const values = credentialValues(
        Option.getOrUndefined(options.credentialEnv),
        Option.getOrUndefined(options.credentialValues)
      )
      return record(await client.request("POST", "/v1/connections", {
        integration: options.integration,
        connection: options.connection,
        ...whenPresent("template", template),
        values
      }))
    }).pipe(Effect.flatMap((result) => {
      const connection = record(result["connection"] ?? result)
      const tools = array(result["tools"])
      const storedName = text(connection["name"])
      // The stored name is normalised, so say so rather than letting the next
      // command fail on the name that was typed.
      if (storedName.length > 0 && storedName !== options.connection) {
        console.error(
          `Note: connection stored as "${storedName}", not "${options.connection}". Use that name from here on.`
        )
      }
      return writeStdoutLine(jsonOutput(
        withNext(
          options.verbose ? { connection, tools } : { connection, toolCount: tools.length },
          `integrations tools ${text(connection["integration"])}`
        ),
        options.verbose
      ))
    }))
).pipe(Command.withDescription("Authorize an integration"))

const connectionsCommand = Command.make(
  "connections",
  { limit: limitFlag(), offset: offsetFlag(), verbose: verboseFlag() },
  ({ limit, offset, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/connections")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(
          array(record(result)["connections"]),
          (connection) => `${text(connection["integration"])} ${text(connection["name"])}`
        )
        return listing(page(all, window(limit, offset)), {
          key: "connections",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No connected integrations.",
          row: (connection) => connection
        })
      })
    )
).pipe(Command.withDescription("List connections without exposing credentials"))

const disconnectCommand = Command.make(
  "disconnect",
  { integration: Argument.string("integration"), connection: connectionFlag() },
  ({ integration, connection }) =>
    gatewayTask((client) =>
      client.request(
        "DELETE",
        `/v1/connections/${encodeURIComponent(integration)}/${encodeURIComponent(connection)}`
      )
    ).pipe(Effect.flatMap((result) => {
      // The gateway resolves the name it actually removed, which may differ
      // from the one typed. Report that one.
      const removed = text(record(result)["connection"] ?? connection)
      return writeStdoutLine(
        jsonOutput({ disconnected: true, integration, connection: removed }, false)
      )
    }))
).pipe(Command.withDescription("Delete a connection"))

// --- invocation -------------------------------------------------------------

/** A tool address is recognisable: an alias is lowercase letters, digits, and
 *  dashes, so it can never look like one. `--direct` states the intent
 *  explicitly and fails if the target is not an address. */
const looksLikeAddress = (value: string): boolean => value.startsWith("tools.")

const executeCommand = Command.make(
  "execute",
  {
    target: Argument.string("alias-or-address").pipe(
      Argument.withDescription("Granted alias, or a tools.… address with --direct")
    ),
    second: Argument.string("tool").pipe(
      Argument.optional,
      Argument.withDescription("Tool name. Omitted in direct mode, where the address names it")
    ),
    third: Argument.string("json").pipe(
      Argument.optional,
      Argument.withDescription("Arguments as JSON (default: {})")
    ),
    direct: Flag.boolean("direct").pipe(
      Flag.withDescription(
        "Call a tool address with this key's own authority, bypassing aliases. For testing a connection"
      )
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Read the JSON input from a file")
    ),
    verbose: verboseFlag()
  },
  ({ target, second, third, direct, file, verbose }) => {
    const isDirect = direct || looksLikeAddress(target)
    return gatewayTask(async (client) => {
      if (isDirect) {
        if (!looksLikeAddress(target)) {
          throw cliError(
            `--direct expects a tools.<integration>.<owner>.<connection>.<tool> address, got "${target}". Copy one from: integrations schema <integration> <tool>`
          )
        }
        if (Option.isSome(third)) {
          throw cliError("In direct mode the address is followed by the JSON input only")
        }
        const payload = await readJsonArgument(
          Option.getOrUndefined(second),
          Option.getOrUndefined(file)
        )
        try {
          return {
            status: "succeeded",
            result: await client.request("POST", "/v1/tools/invoke", {
              address: target,
              arguments: payload
            })
          } as const
        } catch (error) {
          // Reported in the same shape as a delegated call, so one reader
          // handles both. The exit code still says it failed.
          return { status: "failed", message: describeError(error) } as const
        }
      }
      if (Option.isNone(second)) {
        throw cliError("Provide an alias and a tool, or a tools.… address with --direct")
      }
      const payload = await readJsonArgument(
        Option.getOrUndefined(third),
        Option.getOrUndefined(file)
      )
      return await client.execute({
        alias: target,
        tool: second.value,
        arguments: Schema.decodeUnknownSync(Schema.Json)(payload)
      })
    }).pipe(Effect.flatMap((outcome) =>
      // Always whole JSON: this is the machine-facing result, and a document
      // cut mid-token is not a smaller answer, it is an unusable one.
      writeStdoutLine(
        jsonOutput(Schema.decodeUnknownSync(Schema.Json)(outcome), verbose)
      ).pipe(Effect.flatMap(() =>
        outcome.status === "succeeded" || outcome.status === "pending"
          ? Effect.void
          : Effect.fail(cliError(
            outcome.status === "denied" ? outcome.reason : outcome.message
          ))
      ))
    ))
  }
).pipe(
  Command.withAlias("invoke"),
  Command.withDescription(
    "Invoke a granted tool through an alias, as a delegated caller would. --direct calls an address instead"
  )
)

const validateCommand = Command.make(
  "validate",
  {
    config: Argument.string("json-or-tool-address").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    structural: Flag.boolean("structural").pipe(
      Flag.withDescription("Check the shape only, without asking the gateway what resolves")
    ),
    verbose: verboseFlag()
  },
  ({ config, file, structural, verbose }) =>
    gatewayTask(async (client) => {
      const configText = Option.getOrUndefined(config)
      const filePath = Option.getOrUndefined(file)
      if ((configText === undefined) === (filePath === undefined)) {
        throw cliError("Provide exactly one of a JSON config or --file")
      }
      const source = filePath === undefined
        ? looksLikeAddress(configText ?? "")
          ? JSON.stringify({ source: { kind: "executor", address: configText } })
          : configText ?? "{}"
        : await Bun.file(filePath).text()
      return record(await client.request("POST", "/v1/validate", {
        node: decodeJsonText(source),
        // Whether it resolves is the question worth asking, so it is asked by
        // default, for every input form rather than only for a bare address.
        live: !structural
      }))
    }).pipe(Effect.flatMap((report) =>
      writeStdoutLine(jsonOutput(report, verbose)).pipe(
        Effect.flatMap(() =>
          report["ok"] === true
            ? Effect.void
            : Effect.fail(cliError("Integration validation failed"))
        )
      )
    ))
).pipe(
  Command.withDescription(
    "Validate an integration node: a gateway alias, an executor address, or a node config"
  )
)

// --- delegation -------------------------------------------------------------

const clientsCommand = Command.make(
  "clients",
  { limit: limitFlag(), offset: offsetFlag(), verbose: verboseFlag() },
  ({ limit, offset, verbose }) =>
    gatewayTask((client) => client.request("GET", "/v1/clients")).pipe(
      Effect.flatMap((result) => {
        const all = sortedBy(array(record(result)["clients"]), (entry) => text(entry["name"]))
        return listing(page(all, window(limit, offset)), {
          key: "clients",
          narrowing: "window with --limit/--offset",
          verbose,
          empty: "No clients.",
          row: (entry) => entry
        })
      })
    )
).pipe(Command.withDescription("List clients that may hold grants"))

const clientCommand = Command.make(
  "client",
  {
    name: Argument.string("name"),
    mayMutate: Flag.boolean("may-mutate").pipe(
      Flag.withDescription("Allow this client to change the catalog, connections, and grants")
    )
  },
  ({ name, mayMutate }) =>
    gatewayTask((client) => client.request("POST", "/v1/clients", { name, mayMutate })).pipe(
      Effect.flatMap((result) => {
        const created = record(result)
        return writeStdoutLine(jsonOutput(
          withNext(created, `integrations key ${text(created["id"])}`),
          false
        ))
      })
    )
).pipe(Command.withDescription("Create a client that grants can be issued to"))

const keyCommand = Command.make(
  "key",
  { clientId: Argument.string("client-id") },
  ({ clientId }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/clients/${encodeURIComponent(clientId)}/keys`, {})
    ).pipe(Effect.flatMap((result) => {
      const issued = record(result)
      // Shown once. Nothing stores the plaintext, so a lost key is reissued
      // rather than recovered.
      return writeStdoutLine(jsonOutput(issued, false))
    }))
).pipe(Command.withDescription("Issue an API key for a client. Shown once"))

const keysCommand = Command.make(
  "keys",
  {
    clientId: Argument.string("client-id"),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ clientId, limit, offset, verbose }) =>
    gatewayTask((client) =>
      client.request("GET", `/v1/clients/${encodeURIComponent(clientId)}/keys`)
    ).pipe(Effect.flatMap((result) => {
      const all = sortedBy(array(record(result)["keys"]), (key) => text(key["createdAt"]))
      return listing(page(all, window(limit, offset)), {
        key: "keys",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: "No keys issued.",
        next: "integrations revoke key <key-id>",
        row: (key) => key
      })
    }))
).pipe(Command.withDescription("List a client's API keys. Secrets are never shown again"))

const grantCommand = Command.make(
  "grant",
  {
    clientId: Argument.string("client-id"),
    alias: Argument.string("alias"),
    tool: Argument.string("tool"),
    integration: Flag.string("integration").pipe(
      Flag.withDescription("Integration slug the alias resolves to")
    ),
    connection: connectionFlag(),
    requireApproval: Flag.boolean("require-approval").pipe(
      Flag.withDescription("Freeze this tool's calls for a human instead of running them")
    )
  },
  (options) =>
    gatewayTask((client) =>
      client.request("POST", "/v1/grants", {
        clientId: options.clientId,
        alias: options.alias,
        tool: options.tool,
        connection: {
          owner: "org",
          integration: options.integration,
          name: options.connection
        },
        decision: options.requireApproval ? "require_approval" : "allow"
      })
    ).pipe(Effect.flatMap((result) =>
      writeStdoutLine(jsonOutput(record(result), false))
    ))
).pipe(Command.withDescription("Delegate one tool through one connection to one client"))

const grantRow = (tool: GrantedTool) => ({
  alias: tool.alias,
  tool: tool.tool,
  integration: tool.integration,
  decision: tool.decision
})

const grantsCommand = Command.make(
  "grants",
  {
    clientId: Argument.string("client-id").pipe(Argument.optional),
    mine: Flag.boolean("mine").pipe(
      Flag.withDescription("List what this key itself can reach, rather than another client's")
    ),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ clientId, mine, limit, offset, verbose }) =>
    gatewayTask(async (client) => {
      if (mine) {
        if (Option.isSome(clientId)) {
          throw cliError("--mine lists this key's own grants, so it takes no client id")
        }
        return (await client.tools()).map(grantRow)
      }
      if (Option.isNone(clientId)) {
        throw cliError("Provide a client id, or --mine for this key's own grants")
      }
      return array(
        record(
          await client.request("GET", `/v1/grants?clientId=${encodeURIComponent(clientId.value)}`)
        )["grants"]
      )
    }).pipe(Effect.flatMap((grants) => {
      const all = sortedBy(grants, (grant) => `${text(grant["alias"])} ${text(grant["tool"])}`)
      return listing(page(all, window(limit, offset)), {
        key: "grants",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: mine ? "No granted tools." : "No grants.",
        row: (grant) => grant
      })
    }))
).pipe(Command.withDescription("List a client's grants, or this key's own with --mine"))

const revokeCommand = Command.make(
  "revoke",
  {
    kind: Argument.choice("kind", ["grant", "client", "key"]).pipe(
      Argument.withDescription("What to revoke")
    ),
    id: Argument.string("id")
  },
  ({ kind, id }) =>
    gatewayTask((client) =>
      client.request(
        "POST",
        kind === "grant"
          ? `/v1/grants/${encodeURIComponent(id)}/revoke`
          : kind === "client"
          ? `/v1/clients/${encodeURIComponent(id)}/revoke`
          : `/v1/keys/${encodeURIComponent(id)}/revoke`,
        {}
      )
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      return writeStdoutLine(jsonOutput({ revoked: true, kind, id, ...body }, false))
    }))
).pipe(
  Command.withDescription(
    "Revoke a grant, a client, or one API key. Revoked rows stay as history"
  )
)

// --- approvals and audit ----------------------------------------------------

const approvalsCommand = Command.make(
  "approvals",
  {
    status: Flag.choice("status", ["pending", "approved", "denied", "expired"]).pipe(Flag.optional),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ status, limit, offset, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "GET",
        Option.isNone(status) ? "/v1/approvals" : `/v1/approvals?status=${status.value}`
      )
    ).pipe(Effect.flatMap((result) => {
      // Newest first: an approvals queue is read at its head, not its tail.
      const all = [...array(record(result)["approvals"])].sort((left, right) =>
        text(right["createdAt"]).localeCompare(text(left["createdAt"]))
      )
      return listing(page(all, window(limit, offset)), {
        key: "approvals",
        narrowing: "narrow with --status, or window with --limit/--offset",
        verbose,
        empty: "No approvals.",
        next: "integrations approve <id>",
        row: (approval) => approval
      })
    }))
).pipe(Command.withDescription("List frozen invocations awaiting a decision"))

const approvalCommand = Command.make(
  "approval",
  { id: Argument.string("approval-id"), verbose: verboseFlag() },
  ({ id, verbose }) =>
    // Deliberately the delegated route: the caller that proposed a frozen call
    // is the one that needs to watch it, and that caller holds no privileged
    // key. Without this, `execute` hands back an id nothing can resolve.
    gatewayTask((client) => client.approval(id)).pipe(Effect.flatMap((approval) =>
      writeStdoutLine(jsonOutput(approval, verbose))
    ))
).pipe(Command.withDescription("Read one frozen invocation, as the caller that proposed it"))

const approveCommand = Command.make(
  "approve",
  {
    id: Argument.string("approval-id"),
    by: Flag.string("by").pipe(Flag.optional, Flag.withDescription("Record who approved")),
    verbose: verboseFlag()
  },
  ({ id, by, verbose }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, {
        ...Option.match(by, { onNone: () => ({}), onSome: (value) => ({ decidedBy: value }) })
      })
    ).pipe(Effect.flatMap((result) => {
      const body = record(result)
      // The gateway performed the call. Approving discharged one frozen
      // invocation; it did not hand anyone a capability.
      return writeStdoutLine(jsonOutput(body, verbose))
    }))
).pipe(Command.withDescription("Approve a frozen invocation; the gateway then performs it"))

const denyCommand = Command.make(
  "deny",
  {
    id: Argument.string("approval-id"),
    by: Flag.string("by").pipe(Flag.optional),
    verbose: verboseFlag()
  },
  ({ id, by, verbose }) =>
    gatewayTask((client) =>
      client.request("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`, {
        ...Option.match(by, { onNone: () => ({}), onSome: (value) => ({ decidedBy: value }) })
      })
    ).pipe(Effect.flatMap((result) =>
      writeStdoutLine(jsonOutput(record(result), verbose))
    ))
).pipe(Command.withDescription("Deny a frozen invocation"))

const auditCommand = Command.make(
  "audit",
  {
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(50),
      Flag.withDescription("How many records to read (default: 50)")
    ),
    offset: offsetFlag(),
    client: Flag.string("client").pipe(Flag.optional, Flag.withDescription("Only this client id")),
    alias: Flag.string("alias").pipe(Flag.optional, Flag.withDescription("Only this alias")),
    tool: Flag.string("tool").pipe(Flag.optional, Flag.withDescription("Only this tool")),
    outcome: Flag.choice("outcome", ["succeeded", "failed", "denied", "pending"]).pipe(
      Flag.optional,
      Flag.withDescription("Only this outcome")
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("Only records at or after this time (ISO 8601)")
    ),
    verbose: verboseFlag()
  },
  (options) =>
    gatewayTask((client) => {
      // The one listing read through a window rather than whole: the trail is
      // permanent, so "all of it" grows without bound. It is filtered and
      // windowed at the gateway rather than here for the same reason.
      const parameters = new URLSearchParams({
        limit: String(options.limit),
        offset: String(Option.getOrElse(options.offset, () => 0))
      })
      if (Option.isSome(options.client)) parameters.set("clientId", options.client.value)
      if (Option.isSome(options.alias)) parameters.set("alias", options.alias.value)
      if (Option.isSome(options.tool)) parameters.set("tool", options.tool.value)
      if (Option.isSome(options.outcome)) parameters.set("outcome", options.outcome.value)
      if (Option.isSome(options.since)) parameters.set("since", options.since.value)
      return client.request("GET", `/v1/audit?${parameters.toString()}`)
    }).pipe(Effect.flatMap((result) => {
      const body = record(result)
      const records = array(body["records"])
      const total = Predicate.isNumber(body["total"]) ? body["total"] : records.length
      const offset = Predicate.isNumber(body["offset"]) ? body["offset"] : 0
      return writeStdoutLine(jsonOutput(
        { records, count: total, showing: records.length, offset },
        options.verbose
      ))
    }))
).pipe(Command.withDescription("Read the gateway's audit trail"))

const driftCommand = Command.make(
  "drift",
  {
    integration: Argument.string("integration").pipe(Argument.optional),
    limit: limitFlag(),
    offset: offsetFlag(),
    verbose: verboseFlag()
  },
  ({ integration, limit, offset, verbose }) =>
    gatewayTask((client) =>
      client.request(
        "POST",
        Option.isNone(integration)
          ? "/v1/drift/refresh"
          : `/v1/drift/refresh?integration=${encodeURIComponent(integration.value)}`
      )
    ).pipe(Effect.flatMap((result) => {
      const reports = array(record(result)["reports"])
      const baselines = reports.filter((report) => report["baseline"] === true)
      const entries = sortedBy(
        reports.flatMap((report): ReadonlyArray<Record<string, typeof Schema.Json.Type>> =>
          array(report["entries"]).map((entry) => ({ ...entry, integration: report["integration"] ?? null }))
        ),
        (entry) => `${text(entry["integration"])} ${text(entry["tool"])}`
      )
      // A first sync has nothing to compare against. Saying so beats reporting
      // an integration's entire surface as newly added.
      const baselineNote = baselines.length === 0
        ? undefined
        : `Recorded a baseline for ${
          baselines.map((report) => text(report["integration"])).join(", ")
        }; drift is reported from the next refresh.`
      return listing(page(entries, window(limit, offset)), {
        key: "drift",
        narrowing: "window with --limit/--offset",
        verbose,
        empty: baselineNote ?? "No drift since the last refresh.",
        extra: {
          checked: reports.length,
          ...whenPresent("baseline", baselineNote)
        },
        row: (entry) => entry
      })
    }))
).pipe(
  Command.withDescription(
    "Re-read tools and report what a vendor added, removed, or reshaped since the last sync"
  )
)

const codegenCommand = Command.make(
  "codegen",
  {
    target: Flag.choice("target", ["effect", "ts"]).pipe(
      Flag.withDefault("effect" as const),
      Flag.withDescription(
        "effect: Effect Schema plus integration() steps for wf. ts: typed calls over the client"
      )
    ),
    client: Flag.string("client").pipe(
      Flag.optional,
      Flag.withDescription("Generate the surface of another client's grants, by id")
    ),
    out: Flag.string("out").pipe(
      Flag.optional,
      Flag.withDescription("Write to a file instead of stdout")
    )
  },
  ({ target, client: clientId, out }) =>
    gatewayTask(async (client) => {
      // Generated from grants, so the generated surface is the authorized
      // surface. Adding a tool here means adding a grant — for whichever client
      // is being provisioned, which is usually not the one running this.
      const forClient = Option.getOrUndefined(clientId)
      const tools = forClient === undefined
        ? await client.tools({ schemas: true })
        : await client.clientTools(forClient, { schemas: true })
      if (tools.length === 0) {
        throw cliError(
          forClient === undefined
            ? "This key holds no grants, so there is nothing to generate. Generate for another client with --client <id>, or run: integrations grant <client-id> <alias> <tool> --integration <slug>"
            : `Client ${forClient} holds no grants, so there is nothing to generate.`
        )
      }
      const module_ = generateModule(
        Schema.decodeUnknownSync(Schema.Literals(["ts", "effect"]))(target),
        tools,
        client.url
      )
      const destination = Option.getOrUndefined(out)
      if (destination !== undefined) {
        await Bun.write(destination, module_)
        return { written: destination, tools: tools.length }
      }
      return { module: module_, tools: tools.length }
    }).pipe(Effect.flatMap((result) =>
      Predicate.isString(result.module)
        ? writeStdoutLine(result.module)
        : writeStdoutLine(`Wrote ${text(result.written)} (${result.tools} tool(s))`)
    ))
).pipe(Command.withDescription("Generate typed bindings for the tools a key can reach"))

const maintenanceCommand = Command.make(
  "maintenance",
  {},
  () =>
    gatewayTask((client) => client.request("POST", "/v1/maintenance", {})).pipe(
      Effect.flatMap((result) => {
        const body = record(result)
        return writeStdoutLine(jsonOutput(body, false))
      })
    )
).pipe(
  Command.withDescription(
    "Run the sweep the gateway runs on a clock: expire frozen calls and aged-out arguments"
  )
)

export const integrationsSubcommands = [
  discoverCommand,
  searchCommand,
  integrationsCommand,
  toolsCommand,
  schemaCommand,
  connectCommand,
  connectionsCommand,
  disconnectCommand,
  executeCommand,
  validateCommand,
  clientsCommand,
  clientCommand,
  keyCommand,
  keysCommand,
  grantCommand,
  grantsCommand,
  revokeCommand,
  approvalsCommand,
  approvalCommand,
  approveCommand,
  denyCommand,
  auditCommand,
  driftCommand,
  codegenCommand,
  maintenanceCommand
] as const
