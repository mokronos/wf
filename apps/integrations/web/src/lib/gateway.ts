import { Schema } from "effect"
import { whenPresentFields } from "./optional.ts"
import type { JsonEncodable } from "./optional.ts"
import { Predicate } from "effect"
import {
  decodeApprovalDecided,
  decodeApprovals,
  decodeAudit,
  decodeClient,
  decodeClients,
  decodeConnectionCreated,
  decodeConnections,
  decodeDiscovery,
  decodeDrift,
  decodeGrant,
  decodeGrants,
  decodeIntegrations,
  decodeInvocation,
  decodeIssuedKey,
  decodeMaintenance,
  decodeOAuthSession,
  decodeRemoved,
  decodeRevoked,
  decodeTool,
  decodeTools
} from "@/lib/schemas"
import type { ApprovalStatus, GrantDecision } from "@/lib/schemas"

/** The gateway's API, as the control plane uses it.
 *
 * There is no API key here and no place to put one: the page is served by the
 * gateway, so the browser's own same-origin request is what authenticates it.
 * See `apps/integrations/gateway/src/http/loopback.ts` for why that is safe and
 * where it stops being safe.
 */

/** A connection as a request body spells it: the same union as the domain's
 * `ConnectionRef`, minus the brands, because branding is a property of decoded
 * values and this is what goes out on the wire.
 *
 * A decoded `ConnectionRef` is assignable to this, so a grant read back from
 * the gateway can be handed straight to `createGrant` without a cast. */
export type ConnectionRefInput =
  | {
    readonly owner: "org"
    readonly integration: string
    readonly name: string
  }
  | {
    readonly owner: "user"
    readonly subject: string
    readonly integration: string
    readonly name: string
  }

export class GatewayError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "GatewayError"
    this.status = status
  }
}

const messageFrom = (payload: Schema.Json, fallback: string): string => {
  if (Predicate.isObject(payload) && "error" in payload) {
    const error = payload["error"]
    if (Predicate.isString(error) && error.length > 0) return error
  }
  return fallback
}

/** The response body is unparsed text off the wire, so it is decoded rather
 *  than trusted before any caller sees it. */
const decodeJson = Schema.decodeUnknownSync(Schema.Json)

const request = async (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonEncodable
): Promise<Schema.Json> => {
  const response = await fetch(path, {
    method,
    // Same-origin only. Anything else would not be authenticated anyway.
    credentials: "same-origin",
    ...whenPresentFields(body, (present) => ({
      headers: { "content-type": "application/json" },
      body: JSON.stringify(present)
    }))
  })
  const text = await response.text()
  const payload = decodeJson(text.trim().length === 0 ? {} : JSON.parse(text))
  if (!response.ok) {
    throw new GatewayError(
      response.status,
      messageFrom(payload, `${method} ${path} failed with ${response.status}`)
    )
  }
  return payload
}

const query = (parameters: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered.length === 0 ? "" : `?${rendered}`
}

const segment = (value: string): string => encodeURIComponent(value)

// --- catalog and connections ------------------------------------------------

export const listIntegrations = async () =>
  decodeIntegrations(await request("GET", "/v1/integrations")).integrations

export const listIntegrationTools = async (slug: string) =>
  decodeTools(await request("GET", `/v1/integrations/${segment(slug)}/tools`)).tools

export const describeTool = async (input: {
  readonly integration: string
  readonly tool: string
  readonly connection?: string
}) =>
  decodeTool(await request(
    "GET",
    `/v1/integrations/${segment(input.integration)}/tools/${segment(input.tool)}${
      query({ connection: input.connection })
    }`
  ))

export const discoverIntegration = async (input: {
  readonly url: string
  readonly connection?: string
}) => decodeDiscovery(await request("POST", "/v1/integrations/discover", input))

export const listConnections = async () =>
  decodeConnections(await request("GET", "/v1/connections")).connections

export const createConnection = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly values?: Readonly<Record<string, string>>
}) => decodeConnectionCreated(await request("POST", "/v1/connections", input))

export const startOAuth = async (input: {
  readonly integration: string
  readonly connection?: string
  readonly template?: string
  readonly clientId?: string
  readonly clientSecret?: string
}) => decodeOAuthSession(await request("POST", "/v1/connections/oauth", input))

export const pollOAuth = async (id: string) =>
  decodeOAuthSession(await request("GET", `/v1/connections/oauth/${segment(id)}`))

export const removeConnection = async (input: {
  readonly integration: string
  readonly name: string
}) =>
  decodeRemoved(await request(
    "DELETE",
    `/v1/connections/${segment(input.integration)}/${segment(input.name)}`
  ))

export const invokeTool = async (input: {
  readonly address: string
  readonly arguments: JsonEncodable
}) => decodeInvocation(await request("POST", "/v1/tools/invoke", input))

// --- clients, keys, grants --------------------------------------------------

export const listClients = async () =>
  decodeClients(await request("GET", "/v1/clients")).clients

export const createClient = async (input: {
  readonly name: string
  readonly mayMutate: boolean
}) => decodeClient(await request("POST", "/v1/clients", input))

export const issueKey = async (clientId: string) =>
  decodeIssuedKey(await request("POST", `/v1/clients/${segment(clientId)}/keys`))

export const revokeClient = async (clientId: string) =>
  decodeRevoked(await request("POST", `/v1/clients/${segment(clientId)}/revoke`))

export const listGrants = async (clientId: string) =>
  decodeGrants(await request("GET", `/v1/grants${query({ clientId })}`)).grants

export const createGrant = async (input: {
  readonly clientId: string
  readonly alias: string
  readonly tool: string
  readonly connection: ConnectionRefInput
  readonly decision: GrantDecision
}) => decodeGrant(await request("POST", "/v1/grants", input))

export const revokeGrant = async (grantId: string) =>
  decodeRevoked(await request("POST", `/v1/grants/${segment(grantId)}/revoke`))

// --- approvals, audit, upkeep -----------------------------------------------

export const listApprovals = async (status?: ApprovalStatus) =>
  decodeApprovals(await request("GET", `/v1/approvals${query({ status })}`)).approvals

export const approveApproval = async (input: {
  readonly id: string
  readonly decidedBy?: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/approve`,
    { decidedBy: input.decidedBy }
  ))

export const denyApproval = async (input: {
  readonly id: string
  readonly decidedBy?: string
}) =>
  decodeApprovalDecided(await request(
    "POST",
    `/v1/approvals/${segment(input.id)}/deny`,
    { decidedBy: input.decidedBy }
  ))

export const listAudit = async (limit: number) =>
  decodeAudit(await request("GET", `/v1/audit${query({ limit })}`)).records

export const refreshDrift = async (integration?: string) =>
  decodeDrift(await request("POST", `/v1/drift/refresh${query({ integration })}`)).reports

export const runMaintenance = async () =>
  decodeMaintenance(await request("POST", "/v1/maintenance"))
