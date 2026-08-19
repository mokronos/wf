import { Schema } from "effect"

// --- identifiers ------------------------------------------------------------
// Nearly every primitive here is branded: a ClientId and a GrantId are both
// strings, and confusing them would silently authorize the wrong caller.

export const TenantId = Schema.String.pipe(Schema.brand("TenantId"))
export type TenantId = typeof TenantId.Type

/** A human. Never a client — machines are delegated to, they do not hold
 *  connections. See docs/adr/0001. */
export const SubjectId = Schema.String.pipe(Schema.brand("SubjectId"))
export type SubjectId = typeof SubjectId.Type

export const ClientId = Schema.String.pipe(Schema.brand("ClientId"))
export type ClientId = typeof ClientId.Type

export const ApiKeyId = Schema.String.pipe(Schema.brand("ApiKeyId"))
export type ApiKeyId = typeof ApiKeyId.Type

export const GrantId = Schema.String.pipe(Schema.brand("GrantId"))
export type GrantId = typeof GrantId.Type

export const ApprovalId = Schema.String.pipe(Schema.brand("ApprovalId"))
export type ApprovalId = typeof ApprovalId.Type

export const AuditId = Schema.String.pipe(Schema.brand("AuditId"))
export type AuditId = typeof AuditId.Type

/** The logical name a grant exposes a connection under. Callers name this;
 *  each deployment binds it to whatever connection is right there. */
export const Alias = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-z][a-z0-9-]*$/.test(value)),
  Schema.brand("Alias")
)
export type Alias = typeof Alias.Type

export const IntegrationSlug = Schema.String.pipe(Schema.brand("IntegrationSlug"))
export type IntegrationSlug = typeof IntegrationSlug.Type

export const ToolName = Schema.String.pipe(Schema.brand("ToolName"))
export type ToolName = typeof ToolName.Type

/** The label distinguishing several connections to one integration under one
 *  owner tier — three Google accounts as `personal`, `work`, `client-x`. */
export const ConnectionName = Schema.String.pipe(Schema.brand("ConnectionName"))
export type ConnectionName = typeof ConnectionName.Type

/** The SHA-256 of an API key. The key itself is shown once at issue and never
 *  stored, so a leaked database yields no usable credential. */
export const ApiKeyHash = Schema.String.pipe(Schema.brand("ApiKeyHash"))
export type ApiKeyHash = typeof ApiKeyHash.Type

// --- connections ------------------------------------------------------------

/** Which partition a connection is filed under. Not an entity. */
export const OwnerTier = Schema.Literals(["org", "user"])
export type OwnerTier = typeof OwnerTier.Type

/** Identifies one connection. Org-tier connections belong to the whole tenant
 *  and carry no subject; user-tier connections always name the human whose
 *  authorization they are. The union makes the impossible pair — a user-tier
 *  connection with nobody behind it — unrepresentable. */
export const ConnectionRef = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: IntegrationSlug,
    name: ConnectionName
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: SubjectId,
    integration: IntegrationSlug,
    name: ConnectionName
  })
])
export type ConnectionRef = typeof ConnectionRef.Type

/** The human a call acts for, read off the connection rather than the token. */
export const connectionSubject = (connection: ConnectionRef): SubjectId | undefined =>
  connection.owner === "user" ? connection.subject : undefined

// --- clients and keys -------------------------------------------------------

export const Client = Schema.Struct({
  id: ClientId,
  name: Schema.String,
  /** Whether this key may mutate the catalog, connections, grants, and policy.
   *  A local development client has it; one issued to a sandbox does not, so a
   *  prompt-injected agent cannot mint itself new capabilities. */
  mayMutate: Schema.Boolean,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type Client = typeof Client.Type

export const ApiKey = Schema.Struct({
  id: ApiKeyId,
  clientId: ClientId,
  hash: ApiKeyHash,
  createdAt: Schema.Date,
  lastUsedAt: Schema.NullOr(Schema.Date),
  revokedAt: Schema.NullOr(Schema.Date)
})
export type ApiKey = typeof ApiKey.Type

// --- grants -----------------------------------------------------------------

/** There is no `block`. Denial is the absence of a grant, and discovery is
 *  grant-scoped, so an ungranted tool is invisible rather than
 *  visible-then-failing. See docs/adr/0002. */
export const GrantDecision = Schema.Literals(["allow", "require_approval"])
export type GrantDecision = typeof GrantDecision.Type

/** One delegation: this client may invoke this tool through this connection.
 *  Explicit per tool, never a pattern — a vendor shipping a new tool must not
 *  land inside an existing grant. */
export const Grant = Schema.Struct({
  id: GrantId,
  clientId: ClientId,
  alias: Alias,
  tool: ToolName,
  connection: ConnectionRef,
  decision: GrantDecision,
  createdAt: Schema.Date,
  revokedAt: Schema.NullOr(Schema.Date)
})
export type Grant = typeof Grant.Type

// --- authorization ----------------------------------------------------------

/** What a presented key resolves to.
 *
 * `not-granted` deliberately covers both "no such alias" and "alias exists but
 * that tool was never granted". Distinguishing them would turn the gateway into
 * an enumeration oracle for a caller probing what else is connected. */
export const Authorization = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("authorized"),
    client: Client,
    grant: Grant,
    connection: ConnectionRef,
    subject: Schema.NullOr(SubjectId)
  }),
  Schema.Struct({ status: Schema.Literal("unknown-key") }),
  Schema.Struct({ status: Schema.Literal("key-revoked") }),
  Schema.Struct({ status: Schema.Literal("client-revoked") }),
  Schema.Struct({
    status: Schema.Literal("not-granted"),
    alias: Alias,
    tool: ToolName
  })
])
export type Authorization = typeof Authorization.Type

export const describeAuthorization = (authorization: Authorization): string => {
  switch (authorization.status) {
    case "authorized":
      return `authorized ${authorization.grant.alias}.${authorization.grant.tool}`
    case "unknown-key":
      return "the presented API key is not recognised"
    case "key-revoked":
      return "the presented API key has been revoked"
    case "client-revoked":
      return "the client this key belongs to has been revoked"
    case "not-granted":
      return `${authorization.alias}.${authorization.tool} is not granted to this client`
  }
}

// --- approvals --------------------------------------------------------------

export const ApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired"
])
export type ApprovalStatus = typeof ApprovalStatus.Type

/** An invocation frozen awaiting a human. The arguments are captured at propose
 *  time and the gateway performs the call itself on approval, so approving
 *  discharges one specific invocation rather than granting a capability.
 *
 *  One frozen call, not one per attempt: a caller that retries the same
 *  arguments through the same grant meets the approval it already proposed.
 *  Otherwise a step with `retry: { attempts: 3 }` asks a human three times for
 *  one decision. */
export const PendingApproval = Schema.Struct({
  id: ApprovalId,
  clientId: ClientId,
  grantId: GrantId,
  alias: Alias,
  tool: ToolName,
  arguments: Schema.Json,
  status: ApprovalStatus,
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  decidedAt: Schema.NullOr(Schema.Date),
  decidedBy: Schema.NullOr(Schema.String),
  result: Schema.NullOr(Schema.Json),
  error: Schema.NullOr(Schema.String),
  /** When the decision was handed back to the caller. Delivery happens once:
   *  until it does, retries keep meeting this approval; after it, an identical
   *  call is a new request that needs its own decision. */
  collectedAt: Schema.NullOr(Schema.Date)
})
export type PendingApproval = typeof PendingApproval.Type

/** The identity of a frozen call's arguments.
 *
 * Key order is an artefact of how a caller built its JSON, not part of what it
 * asked for, so it is normalised away before two attempts are compared. */
export const canonicalArguments = (value: Schema.Json): string =>
  JSON.stringify(canonicalise(value))

/** Derived from the schema so the guard narrows to a JSON object rather than to
 *  a bag of `unknown`, which would lose the value contract on the way in. */
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const canonicalise = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        // Codepoint order rather than locale order: this string is compared
        // against one written by another process, possibly on another machine.
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalise(nested)])
    )
  }
  return value
}

// --- audit ------------------------------------------------------------------

export const AuditOutcome = Schema.Literals([
  "succeeded",
  "failed",
  "denied",
  "pending"
])
export type AuditOutcome = typeof AuditOutcome.Type

/** The permanent half of the audit trail: who invoked what, for whom, and what
 *  the gateway decided. Small, not sensitive, and kept indefinitely. */
export const AuditRecord = Schema.Struct({
  id: AuditId,
  clientId: Schema.NullOr(ClientId),
  alias: Schema.NullOr(Alias),
  tool: Schema.NullOr(ToolName),
  connection: Schema.NullOr(ConnectionRef),
  subject: Schema.NullOr(SubjectId),
  decision: Schema.NullOr(GrantDecision),
  outcome: AuditOutcome,
  message: Schema.NullOr(Schema.String),
  createdAt: Schema.Date
})
export type AuditRecord = typeof AuditRecord.Type

/** The expiring half. Arguments are where the PII lives and their forensic
 *  value decays within days, so they age out while the record above does not. */
export const AuditArguments = Schema.Struct({
  auditId: AuditId,
  arguments: Schema.Json,
  expiresAt: Schema.Date
})
export type AuditArguments = typeof AuditArguments.Type

// --- catalog drift ----------------------------------------------------------

/** What a tool looked like when it was last synced, so a vendor renaming or
 *  reshaping it is reported rather than discovered at 3am. */
export const ToolSnapshot = Schema.Struct({
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName,
  inputSchema: Schema.NullOr(Schema.Json),
  outputSchema: Schema.NullOr(Schema.Json),
  syncedAt: Schema.Date
})
export type ToolSnapshot = typeof ToolSnapshot.Type

export const DriftKind = Schema.Literals(["added", "removed", "changed"])
export type DriftKind = typeof DriftKind.Type

export const DriftEntry = Schema.Struct({
  kind: DriftKind,
  integration: IntegrationSlug,
  connection: ConnectionName,
  tool: ToolName
})
export type DriftEntry = typeof DriftEntry.Type
