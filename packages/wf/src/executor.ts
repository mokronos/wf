import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs"
import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto"
import path from "node:path"
import { createClient } from "@libsql/client"
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables
} from "@executor-js/fumadb/adapters/drizzle"
import { mcpPlugin } from "@executor-js/plugin-mcp/core"
import { openApiPlugin } from "@executor-js/plugin-openapi/core"
import {
  AuthTemplateSlug,
  ConnectionName,
  createExecutor,
  type CredentialProvider,
  type Executor,
  IntegrationSlug,
  OAuthClientSlug,
  OAuthState,
  ProviderKey,
  type ProviderItemId,
  StorageError,
  Tenant,
  ToolAddress
} from "@executor-js/sdk/core"
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal"
import { drizzle } from "drizzle-orm/libsql"
import { Effect, Option, Schema } from "effect"

const plugins = [
  mcpPlugin({ dangerouslyAllowStdioMCP: false }),
  openApiPlugin()
] as const

type WfExecutor = Executor<typeof plugins>

export const ExecutorToolAddress = Schema.String.pipe(
  Schema.refine(
    (value): value is string => /^tools\.[^.]+\.(org|user)\.[^.]+\..+$/.test(value)
  ),
  Schema.brand("ExecutorToolAddress")
)
export type ExecutorToolAddress = typeof ExecutorToolAddress.Type

export const ExecutorDetection = Schema.Struct({
  kind: Schema.String,
  confidence: Schema.Literals(["high", "medium", "low"]),
  endpoint: Schema.String,
  name: Schema.String,
  slug: Schema.String
})
export type ExecutorDetection = typeof ExecutorDetection.Type

export const ExecutorAuthMethod = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "apikey", "header", "none"]),
  template: Schema.String,
  oauth: Schema.optional(Schema.Struct({
    discoveryUrl: Schema.optional(Schema.String),
    authorizationUrl: Schema.optional(Schema.String),
    tokenUrl: Schema.optional(Schema.String),
    resource: Schema.optional(Schema.NullOr(Schema.String)),
    scopes: Schema.optional(Schema.Array(Schema.String)),
    registrationEndpoint: Schema.optional(Schema.String),
    supportsDynamicRegistration: Schema.optional(Schema.Boolean)
  }))
})
export type ExecutorAuthMethod = typeof ExecutorAuthMethod.Type

export const ExecutorIntegration = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  authMethods: Schema.Array(ExecutorAuthMethod),
  displayUrl: Schema.optional(Schema.String)
})
export type ExecutorIntegration = typeof ExecutorIntegration.Type

export const ExecutorConnection = Schema.Struct({
  owner: Schema.Literals(["org", "user"]),
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  address: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number))
})
export type ExecutorConnection = typeof ExecutorConnection.Type

export const ExecutorTool = Schema.Struct({
  address: ExecutorToolAddress,
  name: Schema.String,
  description: Schema.String,
  integration: Schema.String,
  connection: Schema.String,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String)
})
export type ExecutorTool = typeof ExecutorTool.Type

export const ExecutorMcpProbe = Schema.Struct({
  connected: Schema.Boolean,
  requiresAuthentication: Schema.Boolean,
  requiresOAuth: Schema.Boolean,
  supportsDynamicRegistration: Schema.Boolean,
  name: Schema.String,
  slug: Schema.String,
  toolCount: Schema.NullOr(Schema.Number),
  serverName: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String)
})
export type ExecutorMcpProbe = typeof ExecutorMcpProbe.Type

export const ExecutorOpenApiPreview = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  operationCount: Schema.Number,
  servers: Schema.Array(Schema.Struct({ url: Schema.String })),
  securitySchemes: Schema.Array(Schema.Struct({
    name: Schema.String,
    type: Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]),
    scheme: Schema.NullOr(Schema.String),
    headerName: Schema.NullOr(Schema.String)
  }))
})
export type ExecutorOpenApiPreview = typeof ExecutorOpenApiPreview.Type

const ExecutorToolResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      status: Schema.optional(Schema.Number)
    })
  })
])

const McpToolEnvelope = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Json)),
  isError: Schema.optional(Schema.Boolean)
})

const McpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

const McpEnvelopeOutputSchema = Schema.Struct({
  type: Schema.optional(Schema.Literal("object")),
  properties: Schema.Struct({
    content: Schema.Json,
    structuredContent: Schema.optional(Schema.Json),
    isError: Schema.Struct({
      const: Schema.Literal(false)
    })
  })
})

type Json = typeof Schema.Json.Type

const compactMcpOutputSchema: Json = {}

const isMcpEnvelopeOutputSchema = (schema: Json): boolean =>
  Option.isSome(Schema.decodeUnknownOption(McpEnvelopeOutputSchema)(schema))

export const normalizeExecutorToolOutputSchema = (schema: Json): Json =>
  isMcpEnvelopeOutputSchema(schema) ? compactMcpOutputSchema : schema

const mcpText = (content: ReadonlyArray<Json>): string | undefined => {
  const first = content[0]
  if (content.length !== 1 || first === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(McpTextContent)(first))?.text
}

export const normalizeExecutorToolResult = (data: Json): Json => {
  const envelope = Option.getOrUndefined(Schema.decodeUnknownOption(McpToolEnvelope)(data))
  if (envelope === undefined) return data

  const content = envelope.content ?? []
  const text = mcpText(content)
  if (envelope.isError === true) {
    throw new Error(text ?? "MCP tool returned an error")
  }
  if (envelope.structuredContent !== undefined) return envelope.structuredContent
  if (text !== undefined) {
    return Option.getOrElse(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text),
      () => text
    )
  }
  return content.length > 0 ? content : data
}

const defaultStorageDirectory = (): string =>
  process.env["WF_STORAGE_DIR"] ?? path.join(process.cwd(), ".wf")

let configuredStorageDirectory: string | undefined
const executors = new Map<string, Promise<WfExecutor>>()
const CredentialFile = Schema.Record(Schema.String, Schema.String)
const credentialAdditionalData = Buffer.from("@mokronos/wfkit/executor-credentials/v1")

const credentialKey = (directory: string): Buffer => {
  const keyPath = path.join(directory, "executor-auth.key")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!existsSync(keyPath)) {
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 })
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") {
        throw cause
      }
    }
  }
  chmodSync(keyPath, 0o600)
  const key = readFileSync(keyPath)
  if (key.byteLength !== 32) throw new Error(`Invalid Executor credential key at ${keyPath}`)
  return key
}

const sealCredential = (directory: string, value: string): string => {
  const initializationVector = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", credentialKey(directory), initializationVector)
  cipher.setAAD(credentialAdditionalData)
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return [
    "v1",
    initializationVector.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".")
}

const openCredential = (directory: string, sealed: string): string => {
  const [version, encodedInitializationVector, encodedTag, encodedCiphertext, extra] =
    sealed.split(".")
  if (
    version !== "v1" ||
    encodedInitializationVector === undefined ||
    encodedTag === undefined ||
    encodedCiphertext === undefined ||
    extra !== undefined
  ) {
    throw new Error("Unsupported Executor credential format")
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    credentialKey(directory),
    Buffer.from(encodedInitializationVector, "base64url")
  )
  decipher.setAAD(credentialAdditionalData)
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final()
  ]).toString("utf8")
}

const readCredentials = (filePath: string) => Effect.try({
  try: () => {
    if (!existsSync(filePath)) return {}
    return Schema.decodeUnknownSync(Schema.fromJsonString(CredentialFile))(
      readFileSync(filePath, "utf8")
    )
  },
  catch: (cause) => new StorageError({
    message: `Failed to read Executor credentials from ${filePath}`,
    cause
  })
})

const writeCredentials = (
  filePath: string,
  credentials: typeof CredentialFile.Type
) => Effect.try({
  try: () => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${filePath}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, filePath)
  },
  catch: (cause) => new StorageError({
    message: `Failed to write Executor credentials to ${filePath}`,
    cause
  })
})

const fileCredentialProvider = (directory: string): CredentialProvider => {
  const filePath = path.join(directory, "executor-auth.json")
  return {
    key: ProviderKey.make("wf-file"),
    writable: true,
    get: (id: ProviderItemId) =>
      readCredentials(filePath).pipe(
        Effect.flatMap((credentials) => {
          const sealed = credentials[String(id)]
          if (sealed === undefined) return Effect.succeed(null)
          return Effect.try({
            try: () => openCredential(directory, sealed),
            catch: (cause) => new StorageError({
              message: `Failed to open Executor credential ${String(id)}`,
              cause
            })
          })
        })
      ),
    set: (id: ProviderItemId, value: string) =>
      Effect.try({
        try: () => sealCredential(directory, value),
        catch: (cause) => new StorageError({
          message: `Failed to seal Executor credential ${String(id)}`,
          cause
        })
      }).pipe(
        Effect.flatMap((sealed) =>
          readCredentials(filePath).pipe(
            Effect.flatMap((credentials) =>
              writeCredentials(filePath, { ...credentials, [String(id)]: sealed })
            )
          )
        )
      ),
    delete: (id: ProviderItemId) =>
      readCredentials(filePath).pipe(
        Effect.flatMap((credentials) => {
          const next = Object.fromEntries(
            Object.entries(credentials).filter(([key]) => key !== String(id))
          )
          return writeCredentials(filePath, next)
        })
      )
  }
}

export const setExecutorStorageDirectory = (directory: string): void => {
  configuredStorageDirectory = path.resolve(directory)
}

export const executorStorageDirectory = (): string =>
  configuredStorageDirectory ?? path.resolve(defaultStorageDirectory())

const makeExecutor = async (directory: string): Promise<WfExecutor> => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const executorPlugins = [
    mcpPlugin({ dangerouslyAllowStdioMCP: false }),
    openApiPlugin()
  ] as const
  return await Effect.runPromise(createExecutor({
    tenant: Tenant.make("wf-local"),
    plugins: executorPlugins,
    providers: [fileCredentialProvider(directory)],
    onElicitation: "accept-all",
    db: ({ tables }) => Effect.promise(async () => {
      const databasePath = path.join(directory, "executor.sqlite")
      const client = createClient({ url: `file:${databasePath}` })
      await client.execute("PRAGMA foreign_keys = ON")
      await client.execute("PRAGMA journal_mode = WAL")
      const schema = createDrizzleRuntimeSchemaFromTables({
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const drizzleDatabase = drizzle({ client, schema })
      await ensureDrizzleRuntimeSchemaFromTables(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      const handle = createExecutorFumaDb(drizzleDatabase, {
        tables,
        namespace: "wf_executor",
        version: "1.0.0",
        provider: "sqlite"
      })
      return {
        db: handle.db,
        close: async () => client.close()
      }
    })
  }))
}

export const getExecutor = (): Promise<WfExecutor> => {
  const directory = executorStorageDirectory()
  const existing = executors.get(directory)
  if (existing !== undefined) return existing
  const created = makeExecutor(directory)
  executors.set(directory, created)
  return created
}

export const closeExecutor = async (directory?: string): Promise<void> => {
  const resolved = path.resolve(directory ?? executorStorageDirectory())
  const executor = executors.get(resolved)
  if (executor === undefined) return
  executors.delete(resolved)
  await Effect.runPromise((await executor).close())
}

const runExecutor = async <A, E>(
  operation: (executor: WfExecutor) => Effect.Effect<A, E>
): Promise<A> =>
  await Effect.runPromise(operation(await getExecutor()))

const optionalJson = <A>(value: A | undefined) =>
  value === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(value))

export const detectExecutorIntegration = async (url: string): Promise<ReadonlyArray<ExecutorDetection>> =>
  await runExecutor((executor) => executor.integrations.detect(url))

export const probeExecutorMcp = async (url: string): Promise<ExecutorMcpProbe> =>
  await runExecutor((executor) => executor.mcp.probeEndpoint(url))

export const previewExecutorOpenApi = async (spec: string): Promise<ExecutorOpenApiPreview> => {
  const preview = await runExecutor((executor) => executor.openapi.previewSpec(spec))
  return {
    title: Option.getOrNull(preview.title),
    version: Option.getOrNull(preview.version),
    operationCount: preview.operationCount,
    servers: preview.servers.map((server) => ({ url: server.url })),
    securitySchemes: preview.securitySchemes.map((scheme) => ({
      name: scheme.name,
      type: scheme.type,
      scheme: Option.getOrNull(scheme.scheme),
      headerName: Option.getOrNull(scheme.headerName)
    }))
  }
}

export const addExecutorMcp = async (options: {
  readonly endpoint: string
  readonly name: string
  readonly slug: string
  readonly auth: "none" | "oauth2" | "bearer"
}): Promise<string> =>
  await runExecutor(asyncExecutor => asyncExecutor.mcp.addServer({
    transport: "remote",
    endpoint: options.endpoint,
    name: options.name,
    slug: options.slug,
    auth: options.auth === "bearer"
      ? { kind: "header", headerName: "Authorization", prefix: "Bearer " }
      : { kind: options.auth }
  })).then((result) => result.slug)

export const addExecutorOpenApi = async (options: {
  readonly spec: string
  readonly slug: string
  readonly name?: string
  readonly baseUrl?: string
}): Promise<string> =>
  await runExecutor((executor) => executor.openapi.addSpec({
    spec: { kind: "url", url: options.spec },
    slug: options.slug,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl })
  })).then((result) => String(result.slug))

export const listExecutorIntegrations = async (): Promise<ReadonlyArray<ExecutorIntegration>> =>
  await runExecutor((executor) => executor.integrations.list()).then((integrations) =>
    integrations.map((integration) => ({
      slug: String(integration.slug),
      name: integration.name,
      description: integration.description,
      kind: integration.kind,
      authMethods: integration.authMethods.map((method) => ({
        id: method.id,
        label: method.label,
        kind: method.kind,
        template: method.template,
        ...(method.oauth === undefined ? {} : {
          oauth: {
            ...(method.oauth.discoveryUrl === undefined ? {} : { discoveryUrl: method.oauth.discoveryUrl }),
            ...(method.oauth.authorizationUrl === undefined ? {} : { authorizationUrl: method.oauth.authorizationUrl }),
            ...(method.oauth.tokenUrl === undefined ? {} : { tokenUrl: method.oauth.tokenUrl }),
            ...(method.oauth.resource === undefined ? {} : { resource: method.oauth.resource }),
            ...(method.oauth.scopes === undefined ? {} : { scopes: method.oauth.scopes }),
            ...(method.oauth.registrationEndpoint === undefined ? {} : { registrationEndpoint: method.oauth.registrationEndpoint }),
            ...(method.oauth.supportsDynamicRegistration === undefined
              ? {}
              : { supportsDynamicRegistration: method.oauth.supportsDynamicRegistration })
          }
        })
      })),
      ...(integration.displayUrl === undefined ? {} : { displayUrl: integration.displayUrl })
    }))
  )

export const createExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
  readonly template: string
  readonly value: string
}): Promise<ExecutorConnection> =>
  await runExecutor((executor) => executor.connections.create({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name),
    template: AuthTemplateSlug.make(options.template),
    value: options.value
  })).then((connection) => ({
    owner: connection.owner,
    name: String(connection.name),
    integration: String(connection.integration),
    template: String(connection.template),
    address: String(connection.address),
    ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
  }))

export const listExecutorConnections = async (): Promise<ReadonlyArray<ExecutorConnection>> =>
  await runExecutor((executor) => executor.connections.list()).then((connections) =>
    connections.map((connection) => ({
      owner: connection.owner,
      name: String(connection.name),
      integration: String(connection.integration),
      template: String(connection.template),
      address: String(connection.address),
      ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
      ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
    }))
  )

export const removeExecutorConnection = async (options: {
  readonly integration: string
  readonly name: string
}): Promise<void> =>
  await runExecutor((executor) => executor.connections.remove({
    owner: "org",
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.name)
  }))

export const listExecutorTools = async (filter: {
  readonly integration?: string
  readonly connection?: string
} = {}): Promise<ReadonlyArray<ExecutorTool>> => {
  const executor = await getExecutor()
  const tools = await Effect.runPromise(executor.tools.list({
    ...(filter.integration === undefined ? {} : { integration: IntegrationSlug.make(filter.integration) }),
    ...(filter.connection === undefined ? {} : { connection: ConnectionName.make(filter.connection) })
  }))
  const callableTools = tools.filter((tool) => String(tool.address).startsWith("tools."))
  return await Promise.all(callableTools.map(async (tool) => {
    const schema = await Effect.runPromise(executor.tools.schema(tool.address))
    const inputSchema = optionalJson(schema?.inputSchema)
    const outputSchema = optionalJson(schema?.outputSchema)
    const normalizedOutputSchema = outputSchema === undefined
      ? undefined
      : normalizeExecutorToolOutputSchema(outputSchema)
    const hasMcpEnvelopeOutput = normalizedOutputSchema === compactMcpOutputSchema
    return {
      address: ExecutorToolAddress.make(String(tool.address)),
      name: String(tool.name),
      description: tool.description,
      integration: String(tool.integration),
      connection: String(tool.connection),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(normalizedOutputSchema === undefined ? {} : { outputSchema: normalizedOutputSchema }),
      ...(schema?.inputTypeScript === undefined ? {} : { inputTypeScript: schema.inputTypeScript }),
      ...(hasMcpEnvelopeOutput
        ? { outputTypeScript: "Json" }
        : schema?.outputTypeScript === undefined
          ? {}
          : { outputTypeScript: schema.outputTypeScript })
    }
  }))
}

export const executeExecutorTool = async (
  address: ExecutorToolAddress,
  input: Schema.Schema.Type<typeof Schema.Json>
): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
  const result = await runExecutor((executor) => executor.execute(ToolAddress.make(address), input))
  const decoded = await Schema.decodeUnknownPromise(ExecutorToolResult)(result)
  if (!decoded.ok) {
    throw new Error(`${decoded.error.code}: ${decoded.error.message}`)
  }
  return normalizeExecutorToolResult(decoded.data)
}

export const probeExecutorOAuth = async (url: string) =>
  await runExecutor((executor) => executor.oauth.probe({ url }))

export const registerExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly redirectUri: string
  readonly issuer?: string | null
  readonly registrationEndpoint: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly resource?: string | null
  readonly scopes: ReadonlyArray<string>
  readonly tokenEndpointAuthMethodsSupported?: ReadonlyArray<string>
}): Promise<string> =>
  await runExecutor((executor) => executor.oauth.registerDynamicClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    originIntegration: IntegrationSlug.make(options.integration),
    redirectUri: options.redirectUri,
    registrationEndpoint: options.registrationEndpoint,
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    scopes: options.scopes,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    ...(options.tokenEndpointAuthMethodsSupported === undefined
      ? {}
      : { tokenEndpointAuthMethodsSupported: options.tokenEndpointAuthMethodsSupported })
  })).then(String)

export const createExecutorOAuthClient = async (options: {
  readonly slug: string
  readonly integration: string
  readonly authorizationUrl: string
  readonly tokenUrl: string
  readonly clientId: string
  readonly clientSecret?: string
  readonly resource?: string | null
}): Promise<string> =>
  await runExecutor((executor) => executor.oauth.createClient({
    owner: "org",
    slug: OAuthClientSlug.make(options.slug),
    origin: {
      kind: "manual",
      integration: IntegrationSlug.make(options.integration)
    },
    grant: "authorization_code",
    authorizationUrl: options.authorizationUrl,
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret ?? "",
    ...(options.resource === undefined ? {} : { resource: options.resource })
  })).then(String)

export const startExecutorOAuth = async (options: {
  readonly client: string
  readonly integration: string
  readonly connection: string
  readonly template: string
  readonly redirectUri: string
}) =>
  await runExecutor((executor) => executor.oauth.start({
    owner: "org",
    clientOwner: "org",
    client: OAuthClientSlug.make(options.client),
    integration: IntegrationSlug.make(options.integration),
    name: ConnectionName.make(options.connection),
    template: AuthTemplateSlug.make(options.template),
    redirectUri: options.redirectUri
  }))

export const completeExecutorOAuth = async (options: {
  readonly state: string
  readonly code: string
  readonly callbackDomain?: string | null
}): Promise<ExecutorConnection> =>
  await runExecutor((executor) => executor.oauth.complete({
    state: OAuthState.make(options.state),
    code: options.code,
    ...(options.callbackDomain === undefined ? {} : { callbackDomain: options.callbackDomain })
  })).then((connection) => ({
    owner: connection.owner,
    name: String(connection.name),
    integration: String(connection.integration),
    template: String(connection.template),
    address: String(connection.address),
    ...(connection.identityLabel === undefined ? {} : { identityLabel: connection.identityLabel }),
    ...(connection.expiresAt === undefined ? {} : { expiresAt: connection.expiresAt })
  }))
