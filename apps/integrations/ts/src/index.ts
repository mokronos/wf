import { whenPresent, whenPresentMap } from "./optional.ts"
import { Predicate, Schema } from "effect"

/** The client is deliberately dumb: authenticate, send, decode. Every decision
 * about whether a call may happen, which connection serves it, and whether a
 * human is asked lives behind the gateway.
 *
 * That is the point of the split — a sandbox holding this client holds no
 * authority beyond the grants attached to its key. */

export interface GatewayClientOptions {
  readonly url: string
  readonly apiKey: string
  /** Injected for tests, or to route through a proxy. */
  readonly fetch?: typeof globalThis.fetch
}

export class GatewayError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: Json, message: string) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.body = body
  }
}

type Json = typeof Schema.Json.Type

const GrantedTool = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  integration: Schema.String,
  decision: Schema.Literals(["allow", "require_approval"]),
  inputSchema: Schema.optional(Schema.Json),
  outputSchema: Schema.optional(Schema.Json)
})
export type GrantedTool = typeof GrantedTool.Type

const GrantedTools = Schema.Struct({ tools: Schema.Array(GrantedTool) })

/** What a delegated call comes back as.
 *
 * `pending` is a first-class outcome rather than an error: the gateway froze
 * the call for a human, and the caller polls instead of blocking. Blocking
 * would hold a sandbox process open across a human's lunch break. */
export const InvocationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("succeeded"), result: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    approvalId: Schema.String,
    expiresAt: Schema.String
  }),
  Schema.Struct({ status: Schema.Literal("denied"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String })
])
export type InvocationOutcome = typeof InvocationOutcome.Type

const ApprovalRecord = Schema.Struct({
  id: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
  arguments: Schema.Json,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  /** When the decision was handed back to the caller. A settled approval is
   *  delivered through `execute` exactly once; an identical call after that
   *  asks for a fresh decision rather than replaying an old one. */
  collectedAt: Schema.NullOr(Schema.String)
})
export type ApprovalRecord = typeof ApprovalRecord.Type

const decodeGrantedTools = Schema.decodeUnknownSync(GrantedTools)
const decodeOutcome = Schema.decodeUnknownSync(InvocationOutcome)
const decodeApproval = Schema.decodeUnknownSync(ApprovalRecord)
const isOutcome = Schema.is(InvocationOutcome)

export interface GatewayClient {
  readonly url: string
  request(method: string, path: string, body?: Json): Promise<Json>

  /** The tools this key can reach. Grant-scoped, so an ungranted tool is
   *  absent rather than present-and-failing.
   *
   *  Schemas are opt-in because they cost a catalog read per grant. */
  tools(options?: { readonly schemas?: boolean }): Promise<ReadonlyArray<GrantedTool>>

  /** The tools *another* client can reach. Privileged, and the reason codegen
   *  can emit bindings for the client being provisioned rather than only for
   *  the key running the command. */
  clientTools(
    clientId: string,
    options?: { readonly schemas?: boolean }
  ): Promise<ReadonlyArray<GrantedTool>>

  /** Performs a delegated call.
   *
   *  Every answer the *policy* produced comes back as a value, `denied` and
   *  `failed` included: the gateway answered, and which answer it gave is the
   *  caller's to branch on. A thrown `GatewayError` means the gateway did not
   *  answer at all — bad key, no route, unreachable. */
  execute(input: {
    readonly alias: string
    readonly tool: string
    readonly arguments?: Json
  }): Promise<InvocationOutcome>
  approval(id: string): Promise<ApprovalRecord>
  health(): Promise<boolean>
}

export const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = options.url.replace(/\/+$/, "")

  const send = async (
    method: string,
    path: string,
    body?: Json
  ): Promise<{ readonly ok: boolean; readonly status: number; readonly parsed: Json }> => {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...whenPresentMap("content-type", body, () => "application/json")
      },
      ...whenPresent("body", JSON.stringify(body))
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      parsed: text.trim().length === 0 ? {} : JSON.parse(text)
    }
  }

  const failure = (method: string, path: string, status: number, parsed: Json): GatewayError => {
    // The gateway states a refusal in `error`; a policy answer states it in
    // `reason`. Reading both is what keeps "alias not granted" from being
    // reported as the generic "failed with 403".
    const message = Predicate.isObjectOrArray(parsed)
      ? "error" in parsed
        ? String(parsed["error"])
        : "reason" in parsed
        ? String(parsed["reason"])
        : `${method} ${path} failed with ${status}`
      : `${method} ${path} failed with ${status}`
    return new GatewayError(status, parsed, message)
  }

  const request = async (method: string, path: string, body?: Json): Promise<Json> => {
    const response = await send(method, path, body)
    if (!response.ok) throw failure(method, path, response.status, response.parsed)
    return response.parsed
  }

  const query = (schemas: boolean | undefined): string => schemas === true ? "?schemas=true" : ""

  return {
    url: base,
    request,
    tools: async (options) =>
      decodeGrantedTools(await request("GET", `/v1/tools${query(options?.schemas)}`)).tools,
    clientTools: async (clientId, options) =>
      decodeGrantedTools(
        await request(
          "GET",
          `/v1/clients/${encodeURIComponent(clientId)}/tools${query(options?.schemas)}`
        )
      ).tools,
    execute: async (input) => {
      const response = await send("POST", "/v1/execute", {
        alias: input.alias,
        tool: input.tool,
        arguments: input.arguments ?? {}
      })
      // A denial and a vendor failure are answers, carried on 403 and 502 so
      // that HTTP callers see them too. They decode into the outcome union
      // rather than throwing, so one branch handles every policy result.
      if (!response.ok && !isOutcome(response.parsed)) {
        throw failure("POST", "/v1/execute", response.status, response.parsed)
      }
      return decodeOutcome(response.parsed)
    },
    approval: async (id) => decodeApproval(await request("GET", `/v1/approvals/${id}`)),
    health: async () => {
      try {
        await request("GET", "/v1/health")
        return true
      } catch {
        return false
      }
    }
  }
}

export {
  defaultGatewayPort,
  GatewayConfigFile,
  gatewayConfigPath,
  integrationsHome,
  readGatewayConfig,
  resolveClientConnection,
  writeGatewayConfig
} from "./config.ts"
export type { ClientConnection } from "./config.ts"

export {
  bindingName,
  generateEffectModule,
  generateModule,
  generateTypeScriptModule,
  typeName
} from "./codegen.ts"
export type { CodegenTarget, GeneratableTool } from "./codegen.ts"
