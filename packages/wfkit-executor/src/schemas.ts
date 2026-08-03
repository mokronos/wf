import { Option, Schema } from "effect"

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

/** One catalog integration together with the connections that authorize it and
 *  the tools those connections expose. Unconnected integrations carry an empty
 *  `connections` list, so the dashboard can tell "known" from "usable". */
export const IntegrationOverview = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  displayUrl: Schema.optional(Schema.String),
  requiresAuthentication: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  connections: Schema.Array(ExecutorConnection),
  tools: Schema.Array(ExecutorTool),
  toolError: Schema.optional(Schema.String)
})
export type IntegrationOverview = typeof IntegrationOverview.Type

export const IntegrationsResponse = Schema.Struct({
  generatedAt: Schema.String,
  integrations: Schema.Array(IntegrationOverview),
  error: Schema.optional(Schema.String)
})
export type IntegrationsResponse = typeof IntegrationsResponse.Type

export const decodeIntegrationsResponse = (value: unknown): IntegrationsResponse =>
  Schema.decodeUnknownSync(IntegrationsResponse)(value)

const ErrorPayload = Schema.Struct({ error: Schema.String })

/** A failed dashboard request carries only `{ error }`, so callers can report the
 *  server's message instead of a decoding failure. */
export const errorPayloadMessage = (value: unknown): string | undefined =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(ErrorPayload)(value), (payload) => payload.error)
  )
