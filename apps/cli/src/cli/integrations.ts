import { BunServices } from "@effect/platform-bun"
import { Console, Data, Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  createExecutorConnection,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorTools,
  removeExecutorConnection,
  setExecutorStorageDirectory,
  discoverIntegration,
  validateIntegrationNode
} from "@mokronos/wfkit"
import type {
  ExecutorAuthMethod,
  ExecutorIntegration,
  ExecutorTool
} from "@mokronos/wfkit"
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

const decodeJson = (
  text: string
): Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, IntegrationCliError> =>
  Effect.tryPromise({
    try: () => Schema.decodeUnknownPromise(Schema.fromJsonString(Schema.Json))(text),
    catch: () => cliError("Invalid JSON")
  })

const formatTool = (tool: ExecutorTool): string => {
  const lines = [
    `\n${tool.address}`,
    tool.description,
    `input: ${JSON.stringify(tool.inputSchema ?? {})}`,
    `output: ${JSON.stringify(tool.outputSchema ?? {})}`,
    "integration({",
    `  source: { kind: "executor", address: ${JSON.stringify(tool.address)} },`,
    "  input: t.struct({ /* derive from input schema */ }),",
    "  output: t.struct({ /* derive from output schema */ })",
    "})"
  ]
  return lines.join("\n")
}

const formatDiscovery = (discovery: Awaited<ReturnType<typeof discoverIntegration>>): string => {
  const lines = [
    `url: ${discovery.url}`,
    `detected: ${discovery.detection.kind} (${discovery.detection.confidence})`,
    `integration: ${discovery.integration.slug}`,
    `auth: ${discovery.requiresAuthentication ? "required" : "none"}`
  ]
  if (discovery.authMethods.length > 0) {
    lines.push(`auth methods: ${discovery.authMethods.map((method) =>
      `${method.template}:${method.kind}`
    ).join(", ")}`)
  }
  if (discovery.requiresAuthentication && discovery.tools.length === 0) {
    lines.push(`next: wf integrations connect ${discovery.integration.slug}`)
  }
  lines.push(`tools: ${discovery.tools.length}`)
  for (const tool of discovery.tools) lines.push(formatTool(tool))
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
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print detection, auth, and schemas as JSON")
    )
  },
  ({ url, connection, json }) =>
    Effect.tryPromise({
      try: () => discoverIntegration(url, { connection }),
      catch: (error) => cliError(
        `Integration discovery failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
      )
    }).pipe(
      Effect.flatMap((result) =>
        Console.log(json ? JSON.stringify(result, null, 2) : formatDiscovery(result))
      )
    )
).pipe(
  Command.withDescription("Detect, register, inspect auth, and list tool schemas from one URL")
)

const makeCatalog = () => Command.make(
  "catalog",
  { json: Flag.boolean("json") },
  ({ json }) => Effect.tryPromise({
    try: () => listExecutorIntegrations(),
    catch: (error) => cliError(`Could not list integrations: ${String(error)}`)
  }).pipe(
    Effect.flatMap((integrations) => Console.log(
      json
        ? JSON.stringify({ integrations }, null, 2)
        : integrations.map((integration) =>
            `${integration.slug}\t${integration.kind}\t${integration.name}\t${integration.authMethods.map((method) => method.kind).join(",")}`
          ).join("\n") || "No integrations discovered."
    ))
  )
).pipe(Command.withDescription("List Executor's persisted integration catalog"))

const makeTools = () => Command.make(
  "tools",
  {
    integration: Flag.string("integration").pipe(Flag.optional),
    connection: Flag.string("connection").pipe(Flag.optional),
    json: Flag.boolean("json")
  },
  ({ integration, connection, json }) => Effect.tryPromise({
    try: () => listExecutorTools({
      ...Option.match(integration, {
        onNone: () => ({}),
        onSome: (value) => ({ integration: value })
      }),
      ...Option.match(connection, {
        onNone: () => ({}),
        onSome: (value) => ({ connection: value })
      })
    }),
    catch: (error) => cliError(`Could not list tools: ${String(error)}`)
  }).pipe(
    Effect.flatMap((tools) => Console.log(
      json
        ? JSON.stringify({ tools }, null, 2)
        : tools.map(formatTool).join("\n") || "No tools available."
    ))
  )
).pipe(Command.withDescription("List Executor tool names and input/output schemas"))

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
    timeout: Flag.integer("timeout").pipe(Flag.withDefault(300))
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
    timeout
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
          onAuthorizationUrl: (url) => console.log(`Authorize in your browser:\n${url}`)
        })
        const tools = await listExecutorTools({
          integration: integration.slug,
          connection: connected.name
        })
        return `Connected ${connected.address}\n${tools.map(formatTool).join("\n")}`
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
      const tools = await listExecutorTools({
        integration: integration.slug,
        connection: connected.name
      })
      return `Connected ${connected.address}\n${tools.map(formatTool).join("\n")}`
    },
    catch: (error) => cliError(
      `Connection failed: ${error instanceof Error ? errorMessage(error) : String(error)}`
    )
  }).pipe(Effect.flatMap(Console.log))
).pipe(Command.withDescription("Authorize an Executor integration and discover its tool schemas"))

const makeConnections = () => Command.make(
  "connections",
  { json: Flag.boolean("json") },
  ({ json }) => Effect.tryPromise({
    try: () => listExecutorConnections(),
    catch: (error) => cliError(`Could not list connections: ${String(error)}`)
  }).pipe(
    Effect.flatMap((connections) => Console.log(
      json
        ? JSON.stringify({ connections }, null, 2)
        : connections.map((connection) =>
            `${connection.integration}\t${connection.name}\t${connection.template}\t${connection.address}`
          ).join("\n") || "No connected integrations."
    ))
  )
).pipe(Command.withDescription("List Executor connections without exposing credentials"))

const makeDisconnect = () => Command.make(
  "disconnect",
  {
    integration: Argument.string("integration"),
    connection: Flag.string("connection").pipe(Flag.withDefault("default"))
  },
  ({ integration, connection }) => Effect.tryPromise({
    try: () => removeExecutorConnection({ integration, name: connection }),
    catch: (error) => cliError(`Disconnect failed: ${String(error)}`)
  }).pipe(Effect.flatMap(() => Console.log(`Disconnected ${integration}/${connection}`)))
).pipe(Command.withDescription("Delete an Executor connection and its stored credential"))

const makeValidate = () => Command.make(
  "validate",
  {
    config: Argument.string("json").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
    live: Flag.boolean("live"),
    json: Flag.boolean("json")
  },
  ({ config, file, live, json }) => Effect.gen(function*() {
    const configText = Option.getOrUndefined(config)
    const filePath = Option.getOrUndefined(file)
    if ((configText === undefined) === (filePath === undefined)) {
      return yield* cliError("Provide exactly one of a JSON config or --file")
    }
    let source: string
    if (filePath === undefined) {
      if (configText === undefined) return yield* cliError("Provide a JSON config")
      source = configText
    } else {
      source = yield* Effect.tryPromise({
        try: () => Bun.file(filePath).text(),
        catch: () => cliError(`Could not read integration configuration: ${filePath}`)
      })
    }
    const node = yield* decodeJson(source)
    const report = yield* Effect.tryPromise({
      try: () => validateIntegrationNode(node, { live }),
      catch: (error) => cliError(`Integration validation failed: ${String(error)}`)
    })
    yield* Console.log(
      json
        ? JSON.stringify(report, null, 2)
        : report.findings.map((entry) =>
            `${entry.severity}\t${entry.check}\t${entry.message}`
          ).join("\n")
    )
    if (!report.ok) return yield* cliError("Integration validation failed")
  })
).pipe(Command.withDescription("Validate an Executor tool address"))

const integrationsCommand = (options: IntegrationsCliOptions) =>
  Command.make("integrations").pipe(
    Command.withDescription("Discover, authorize, inspect, and invoke through Executor"),
    Command.withSubcommands([
      makeDiscover(),
      makeCatalog(),
      makeTools(),
      makeConnect(options),
      makeConnections(),
      makeDisconnect(),
      makeValidate()
    ])
  )

export const runIntegrationsCli = (
  arguments_: ReadonlyArray<string>,
  options: IntegrationsCliOptions = {}
): Promise<void> => {
  if (options.storageDir !== undefined) setExecutorStorageDirectory(options.storageDir)
  return Effect.runPromise(
    Command.runWith(integrationsCommand(options), { version: "0.3.0" })(arguments_).pipe(
      Effect.catchTag("ShowHelp", (error) => error.errors.length === 0
        ? Effect.void
        : Effect.sync(() => { process.exitCode = 1 })),
      Effect.provide(BunServices.layer)
    )
  )
}
