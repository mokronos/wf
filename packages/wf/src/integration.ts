import { Schema } from "effect"
import type { Step, StepRetryPolicy } from "./core.ts"

const AuthRefPrefix = "auth:"

export const AuthRef = Schema.declare<string>(
  (value): value is string => typeof value === "string" && value.startsWith(AuthRefPrefix)
).pipe(Schema.brand("AuthRef"))

export type AuthRef = typeof AuthRef.Type

export const auth = (name: string): AuthRef => AuthRef.make(`${AuthRefPrefix}${name}`)

const authName = (reference: AuthRef): string => reference.slice(AuthRefPrefix.length)

export type IntegrationAuth =
  | { readonly kind: "bearer"; readonly credential: AuthRef }
  | { readonly kind: "api-key"; readonly credential: AuthRef; readonly header?: string }
  | { readonly kind: "header"; readonly credential: AuthRef; readonly header: string; readonly prefix?: string }

export type IntegrationSource =
  | { readonly kind: "mcp"; readonly url: string }
  | {
    readonly kind: "openapi"
    readonly url: string
    readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT"
    readonly path?: string
  }

export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
  operation: Schema.String,
  status: Schema.optional(Schema.Number)
}) {}

const IntegrationErrorSchema = IntegrationError

const JsonRpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Union([Schema.String, Schema.Number]),
  result: Schema.optional(Schema.Json),
  error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(Schema.Json) }))
})

const McpCallResult = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String)
  })))
})

const decodeJson = async (response: Response): Promise<Schema.Schema.Type<typeof Schema.Json>> =>
  Schema.decodeUnknownPromise(Schema.Json)(await response.json())

const resolveAuthorizationHeaders = async (
  reference: IntegrationAuth | undefined,
  resolveSecret: (name: string) => Promise<string>
): Promise<Record<string, string>> => {
  if (reference === undefined) return {}
  const credential = await resolveSecret(authName(reference.credential))
  switch (reference.kind) {
    case "bearer": return { authorization: `Bearer ${credential}` }
    case "api-key": return { [reference.header ?? "x-api-key"]: credential }
    case "header": return { [reference.header]: `${reference.prefix ?? ""}${credential}` }
  }
}

const operationUrl = (source: Extract<IntegrationSource, { readonly kind: "openapi" }>): URL =>
  new URL(source.path ?? "", source.url)

const executeOpenApi = async (options: {
  readonly source: Extract<IntegrationSource, { readonly kind: "openapi" }>
  readonly operation: string
  readonly headers: Record<string, string>
  readonly input: Schema.Schema.Type<typeof Schema.Json>
}): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
  const response = await fetch(operationUrl(options.source), {
    method: options.source.method,
    headers: { "content-type": "application/json", ...options.headers },
    ...(options.source.method === "GET" || options.source.method === "DELETE"
      ? {}
      : { body: JSON.stringify(options.input) })
  })
  if (!response.ok) {
    throw new IntegrationError({
      message: `${options.operation} failed: ${response.status} ${response.statusText}`,
      operation: options.operation,
      status: response.status
    })
  }
  return await decodeJson(response)
}

const executeMcp = async (options: {
  readonly source: Extract<IntegrationSource, { readonly kind: "mcp" }>
  readonly operation: string
  readonly headers: Record<string, string>
  readonly input: Schema.Schema.Type<typeof Schema.Json>
}): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
  const post = (body: Schema.Schema.Type<typeof Schema.Json>, sessionId?: string) => fetch(options.source.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.headers,
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId })
    },
    body: JSON.stringify(body)
  })

  const initializeResponse = await post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "@mokronos/wfkit", version: "0.2.0" }
    }
  })
  if (!initializeResponse.ok) {
    throw new IntegrationError({
      message: `${options.operation} MCP initialization failed: ${initializeResponse.status} ${initializeResponse.statusText}`,
      operation: options.operation,
      status: initializeResponse.status
    })
  }
  await Schema.decodeUnknownPromise(JsonRpcResponse)(await initializeResponse.json())
  const sessionId = initializeResponse.headers.get("mcp-session-id") ?? undefined
  const initializedResponse = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId)
  if (!initializedResponse.ok) {
    throw new IntegrationError({
      message: `${options.operation} MCP initialization notification failed: ${initializedResponse.status}`,
      operation: options.operation,
      status: initializedResponse.status
    })
  }

  const response = await post(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: options.operation, arguments: options.input } },
    sessionId
  )
  if (!response.ok) {
    throw new IntegrationError({
      message: `${options.operation} failed: ${response.status} ${response.statusText}`,
      operation: options.operation,
      status: response.status
    })
  }
  const payload = await Schema.decodeUnknownPromise(JsonRpcResponse)(await response.json())
  if (payload.error !== undefined) {
    throw new IntegrationError({ message: payload.error.message, operation: options.operation })
  }
  if (payload.result === undefined) {
    throw new IntegrationError({ message: `${options.operation} returned no result`, operation: options.operation })
  }
  const callResult = await Schema.decodeUnknownPromise(McpCallResult)(payload.result)
  return callResult.structuredContent ?? payload.result
}

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly operation: string
  readonly auth?: IntegrationAuth
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): Step<I, O, IntegrationError> => ({
  name: config.name ?? `Integration:${config.operation}`,
  input: config.input,
  output: config.output,
  errors: IntegrationErrorSchema,
  ...(config.retry === undefined ? {} : { retry: config.retry }),
  execute: async (input, step) => {
    const headers = await resolveAuthorizationHeaders(config.auth, step.resolveSecret)
    const jsonInput = Schema.decodeUnknownSync(Schema.Json)(input)
    const result = config.source.kind === "mcp"
      ? await executeMcp({ source: config.source, operation: config.operation, headers, input: jsonInput })
      : await executeOpenApi({ source: config.source, operation: config.operation, headers, input: jsonInput })
    return await Schema.decodeUnknownPromise(config.output)(result)
  }
})
