import { whenPresent } from "@mokronos/wfkit"
import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor/schemas"
import { authorizeInvocation } from "./authorize.ts"
import { defaultApprovalExpiryHours, defaultArgumentRetentionDays } from "./config.ts"
import { describeAuthorization } from "./domain.ts"
import type {
  Alias,
  ApprovalId,
  Authorization,
  ConnectionRef,
  Grant,
  ToolName
} from "./domain.ts"
import { newApprovalId, newAuditId } from "./keys.ts"
import type { GatewayStore, RecordAuditInput } from "./store.ts"

type Json = typeof Schema.Json.Type

/** The address is built from the grant, never accepted from the caller. That is
 * what makes invocation-by-address safe to expose: a caller naming an address
 * directly still has to hold a grant that produces it. */
export const grantToolAddress = (connection: ConnectionRef, tool: ToolName): ExecutorToolAddress =>
  ExecutorToolAddress.make(
    `tools.${connection.integration}.${connection.owner}.${connection.name}.${tool}`
  )

export type InvocationOutcome =
  | { readonly status: "succeeded"; readonly result: Json }
  | { readonly status: "pending"; readonly approvalId: ApprovalId; readonly expiresAt: Date }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "failed"; readonly message: string }

export interface InvokeDependencies {
  readonly store: GatewayStore
  readonly executor: Pick<ExecutorServices, "tools">
  readonly argumentRetentionDays?: number
  readonly approvalExpiryHours?: number
}

const auditFor = (
  authorization: Extract<Authorization, { status: "authorized" }>,
  outcome: RecordAuditInput["outcome"],
  message: string | null,
  argumentsValue: Json,
  retentionDays: number
): RecordAuditInput => ({
  id: newAuditId(),
  clientId: authorization.client.id,
  alias: authorization.grant.alias,
  tool: authorization.grant.tool,
  connection: authorization.connection,
  decision: authorization.grant.decision,
  outcome,
  message,
  arguments: {
    value: argumentsValue,
    expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
})

/** The approval half of an invocation: meet the frozen call this request
 * already belongs to, or freeze a new one.
 *
 * A caller that retries — and the retrying caller is the normal case, because a
 * durable step is how a workflow waits — must not ask a human again for a
 * decision it already asked for. So the same (grant, arguments) resolves to the
 * same approval until that approval's outcome has been handed back exactly
 * once. After delivery an identical call is a *new* request, and needs its own
 * decision; replaying an old approval forever would turn one "yes" into
 * standing permission, which is precisely what this design refuses to grant. */
const freezeOrCollect = async (
  dependencies: {
    readonly store: GatewayStore
    readonly retentionDays: number
    readonly expiryHours: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Promise<InvocationOutcome> => {
  const { store, retentionDays } = dependencies
  const existing = await store.findUncollectedApproval(authorization.grant.id, argumentsValue)

  if (existing !== undefined && existing.status === "pending") {
    // Deliberately not audited: the frozen call was recorded when it was
    // proposed, and one decision pending is one event, however many times a
    // retry loop looks at it.
    return { status: "pending", approvalId: existing.id, expiresAt: existing.expiresAt }
  }

  if (existing !== undefined && await store.collectApproval(existing.id)) {
    if (existing.status === "approved") {
      // The gateway already performed this call, at approval time. What is
      // being handed back is that call's result, not a second call.
      await store.recordAudit(auditFor(
        authorization,
        existing.error === null ? "succeeded" : "failed",
        `approval ${existing.id} collected`,
        argumentsValue,
        retentionDays
      ))
      return existing.error === null
        ? { status: "succeeded", result: existing.result }
        : { status: "failed", message: existing.error }
    }
    const reason = existing.status === "expired"
      ? `approval ${existing.id} expired before a decision was recorded`
      : `approval ${existing.id} was denied${
        existing.decidedBy === null ? "" : ` by ${existing.decidedBy}`
      }`
    await store.recordAudit(
      auditFor(authorization, "denied", reason, argumentsValue, retentionDays)
    )
    return { status: "denied", reason }
  }

  const approval = await store.createApproval({
    id: newApprovalId(),
    clientId: authorization.client.id,
    grantId: authorization.grant.id,
    alias: authorization.grant.alias,
    tool: authorization.grant.tool,
    arguments: argumentsValue,
    expiresAt: new Date(Date.now() + dependencies.expiryHours * 60 * 60 * 1000)
  })
  await store.recordAudit(
    auditFor(authorization, "pending", `approval ${approval.id}`, argumentsValue, retentionDays)
  )
  return { status: "pending", approvalId: approval.id, expiresAt: approval.expiresAt }
}

/** Performs one delegated invocation: authorize, then either execute with
 * injected credentials or freeze the call for a human.
 *
 * Every branch writes an audit record, including the denials that never reached
 * a connection — an audit trail with holes where the refusals were is not much
 * of an audit trail. */
export const invokeThroughGateway = async (
  dependencies: InvokeDependencies,
  input: {
    readonly secret: string
    readonly alias: Alias
    readonly tool: ToolName
    readonly arguments: Json
  }
): Promise<InvocationOutcome> => {
  const { store, executor } = dependencies
  const retentionDays = dependencies.argumentRetentionDays ?? defaultArgumentRetentionDays
  const expiryHours = dependencies.approvalExpiryHours ?? defaultApprovalExpiryHours

  const authorization = await authorizeInvocation(store, {
    secret: input.secret,
    alias: input.alias,
    tool: input.tool
  })

  if (authorization.status !== "authorized") {
    // No client id: an unknown key names nobody. The reason is still recorded.
    await store.recordAudit({
      id: newAuditId(),
      clientId: null,
      alias: input.alias,
      tool: input.tool,
      connection: null,
      decision: null,
      outcome: "denied",
      message: describeAuthorization(authorization)
    })
    return { status: "denied", reason: describeAuthorization(authorization) }
  }

  if (authorization.grant.decision === "require_approval") {
    return await freezeOrCollect(
      { store, retentionDays, expiryHours },
      authorization,
      input.arguments
    )
  }

  return await executeAuthorized(
    { store, executor, retentionDays },
    authorization,
    input.arguments
  )
}

/** Runs a call that has already cleared policy. Shared by the allow path and by
 * approval settlement, so an approved invocation is performed by the gateway on
 * exactly the same code path — the caller never gains the capability itself. */
export const executeAuthorized = async (
  dependencies: {
    readonly store: GatewayStore
    readonly executor: Pick<ExecutorServices, "tools">
    readonly retentionDays: number
  },
  authorization: Extract<Authorization, { status: "authorized" }>,
  argumentsValue: Json
): Promise<InvocationOutcome> => {
  const address = grantToolAddress(authorization.connection, authorization.grant.tool)
  try {
    const result = await dependencies.executor.tools.execute(address, argumentsValue)
    await dependencies.store.recordAudit(
      auditFor(authorization, "succeeded", null, argumentsValue, dependencies.retentionDays)
    )
    return { status: "succeeded", result }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Integration call failed"
    await dependencies.store.recordAudit(
      auditFor(authorization, "failed", message, argumentsValue, dependencies.retentionDays)
    )
    return { status: "failed", message }
  }
}

export type GrantedTool = {
  readonly alias: Alias
  readonly tool: ToolName
  readonly integration: string
  readonly decision: Grant["decision"]
  readonly inputSchema?: Json
  readonly outputSchema?: Json
}

/** The tools a client may actually reach. Discovery is grant-scoped, which is
 * why there is no `block` decision: an ungranted tool is invisible rather than
 * visible-then-failing.
 *
 * Schemas are opt-in because fetching them costs one catalog read per grant.
 * With them, this listing is exactly what codegen emits — so the generated
 * surface and the authorized surface cannot drift apart. */
export const listGrantedTools = async (
  store: GatewayStore,
  clientId: Parameters<GatewayStore["listGrants"]>[0],
  options: {
    readonly schemas?: boolean
    readonly executor?: Pick<ExecutorServices, "tools">
  } = {}
): Promise<ReadonlyArray<GrantedTool>> => {
  const grants = await store.listGrants(clientId)
  const base = grants.map((grant) => ({
    alias: grant.alias,
    tool: grant.tool,
    integration: grant.connection.integration,
    decision: grant.decision
  }))
  if (options.schemas !== true || options.executor === undefined) return base

  const executor = options.executor
  return await Promise.all(base.map(async (entry, index) => {
    const grant = grants[index]
    if (grant === undefined) return entry
    try {
      const described = await executor.tools.describe(
        grantToolAddress(grant.connection, grant.tool)
      )
      return {
        ...entry,
        ...whenPresent("inputSchema", described.inputSchema),
        ...whenPresent("outputSchema", described.outputSchema)
      }
    } catch {
      // A tool that has since disappeared should not fail the whole listing —
      // that is what `integrations drift` is for.
      return entry
    }
  }))
}
