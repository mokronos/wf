import { Function, Option, Schema } from "effect"

/** Which principal a connection — and so every tool reached through it —
 *  belongs to. `org` credentials are shared by the whole tenant; `user`
 *  credentials belong to the acting subject. The tool address names this
 *  segment, so the two are distinct addresses rather than one shadowing the
 *  other. */
export const ExecutorOwner = Schema.Literals(["org", "user"])
export type ExecutorOwner = typeof ExecutorOwner.Type

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

export const ExecutorAuthPlacement = Schema.Struct({
  carrier: Schema.Literals(["header", "query", "env"]),
  name: Schema.String,
  prefix: Schema.String,
  variable: Schema.optional(Schema.String),
  literal: Schema.optional(Schema.String)
})
export type ExecutorAuthPlacement = typeof ExecutorAuthPlacement.Type

export const ExecutorAuthMethod = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "apikey", "header", "none"]),
  template: Schema.String,
  placements: Schema.optional(Schema.Array(ExecutorAuthPlacement)),
  oauth: Schema.optional(Schema.Struct({
    discoveryUrl: Schema.optional(Schema.String),
    authorizationUrl: Schema.optional(Schema.String),
    tokenUrl: Schema.optional(Schema.String),
    resource: Schema.optional(Schema.NullOr(Schema.String)),
    scopes: Schema.optional(Schema.Array(Schema.String)),
    registrationEndpoint: Schema.optional(Schema.String),
    supportsDynamicRegistration: Schema.optional(Schema.Boolean),
    supportsClientIdMetadataDocument: Schema.optional(Schema.Boolean)
  }))
})
export type ExecutorAuthMethod = typeof ExecutorAuthMethod.Type

export const ExecutorIntegration = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  description: Schema.String,
  kind: Schema.String,
  canRemove: Schema.Boolean,
  canRefresh: Schema.Boolean,
  authMethods: Schema.Array(ExecutorAuthMethod),
  displayUrl: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String)
})
export type ExecutorIntegration = typeof ExecutorIntegration.Type

export const ExecutorConnection = Schema.Struct({
  owner: ExecutorOwner,
  name: Schema.String,
  integration: Schema.String,
  template: Schema.String,
  address: Schema.String,
  provider: Schema.String,
  identityLabel: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClient: Schema.optional(Schema.NullOr(Schema.String)),
  oauthClientOwner: Schema.optional(Schema.NullOr(ExecutorOwner)),
  oauthScope: Schema.optional(Schema.NullOr(Schema.String)),
  missingOAuthScopes: Schema.optional(Schema.Array(Schema.String)),
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number))
})
export type ExecutorConnection = typeof ExecutorConnection.Type

export const ExecutorOAuthProbe = Schema.Struct({
  issuer: Schema.optional(Schema.NullOr(Schema.String)),
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  resource: Schema.optional(Schema.NullOr(Schema.String)),
  scopesSupported: Schema.optional(Schema.Array(Schema.String)),
  registrationEndpoint: Schema.optional(Schema.NullOr(Schema.String)),
  tokenEndpointAuthMethodsSupported: Schema.optional(Schema.Array(Schema.String)),
  clientIdMetadataDocumentSupported: Schema.optional(Schema.Boolean)
})
export type ExecutorOAuthProbe = typeof ExecutorOAuthProbe.Type

export const ExecutorOAuthStart = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("connected"),
    connection: ExecutorConnection
  }),
  Schema.Struct({
    status: Schema.Literal("redirect"),
    authorizationUrl: Schema.String,
    state: Schema.String
  })
])
export type ExecutorOAuthStart = typeof ExecutorOAuthStart.Type

/** A tool's identity and purpose without its schemas. Listing this level of
 *  detail keeps browsing an integration cheap; `ExecutorTool` is the follow-up
 *  for one chosen tool.
 *
 *  `owner` and `connection` together spell out the two address segments between
 *  the integration and the tool name, so a reader never has to parse `address`
 *  back apart to learn which credentials a tool runs under. */
export const ExecutorToolSummary = Schema.Struct({
  address: ExecutorToolAddress,
  name: Schema.String,
  description: Schema.String,
  integration: Schema.String,
  owner: ExecutorOwner,
  connection: Schema.String
})
export type ExecutorToolSummary = typeof ExecutorToolSummary.Type

export const ExecutorTool = Schema.Struct({
  ...ExecutorToolSummary.fields,
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json),
  schemaDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  inputTypeScript: Schema.optional(Schema.String),
  outputTypeScript: Schema.optional(Schema.String),
  typeScriptDefinitions: Schema.optional(Schema.Record(Schema.String, Schema.String))
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
  description: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  operationCount: Schema.Number,
  operations: Schema.Array(Schema.Struct({
    operationId: Schema.String,
    method: Schema.Literals(["get", "put", "post", "delete", "patch", "head", "options", "trace"]),
    path: Schema.String,
    summary: Schema.NullOr(Schema.String),
    tags: Schema.Array(Schema.String),
    deprecated: Schema.Boolean
  })),
  tags: Schema.Array(Schema.String),
  servers: Schema.Array(Schema.Struct({
    url: Schema.String,
    description: Schema.NullOr(Schema.String)
  })),
  securitySchemes: Schema.Array(Schema.Struct({
    name: Schema.String,
    type: Schema.Literals(["http", "apiKey", "oauth2", "openIdConnect"]),
    scheme: Schema.NullOr(Schema.String),
    bearerFormat: Schema.NullOr(Schema.String),
    in: Schema.NullOr(Schema.Literals(["header", "query", "cookie"])),
    headerName: Schema.NullOr(Schema.String),
    description: Schema.NullOr(Schema.String),
    openIdConnectUrl: Schema.NullOr(Schema.String)
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

export const decodeIntegrationsResponse = Schema.decodeUnknownSync(IntegrationsResponse)

const ErrorPayload = Schema.Struct({ error: Schema.String })

/** A failed dashboard request carries only `{ error }`, so callers can report the
 *  server's message instead of a decoding failure. */
export const errorPayloadMessage = Function.flow(
  Schema.decodeUnknownOption(ErrorPayload),
  Option.map((payload) => payload.error),
  Option.getOrUndefined
)
