import { whenPresent, whenPresentMap } from "@mokronos/wfkit"
import { Schema } from "effect"
import type { ExecutorServices } from "@mokronos/wfkit-executor"
import { searchIntegrations } from "@mokronos/wfkit-executor"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor/schemas"
import { refreshIntegrationSnapshot } from "../drift.ts"
import { runMaintenance } from "../maintenance.ts"
import type { OAuthSessions } from "../oauth-sessions.ts"
import {
  Alias,
  ApiKeyId,
  ApprovalId,
  ClientId,
  ConnectionName,
  GrantId,
  IntegrationSlug,
  SubjectId,
  ToolName
} from "../domain.ts"
import type { ConnectionRef } from "../domain.ts"
import {
  executeAuthorized,
  grantToolAddress,
  invokeThroughGateway,
  listGrantedTools
} from "../invoke.ts"
import { generateApiKey, newClientId, newGrantId } from "../keys.ts"
import type { GatewayStore } from "../store.ts"
import { badRequest, created, decodeBody, notFound, ok } from "./router.ts"
import type { Route } from "./router.ts"

export interface ApiDependencies {
  readonly store: GatewayStore
  readonly executor: ExecutorServices
  readonly retentionDays: number
  readonly oauth: OAuthSessions
  /** Overrides the public registry for an isolated deployment or acceptance test. */
  readonly registryUrl?: string
}

// --- wire schemas -----------------------------------------------------------

const ExecuteBody = Schema.Struct({
  alias: Schema.String,
  tool: Schema.String,
  arguments: Schema.optional(Schema.Json)
})

const ConnectionRefBody = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("org"),
    integration: Schema.String,
    name: Schema.String
  }),
  Schema.Struct({
    owner: Schema.Literal("user"),
    subject: Schema.String,
    integration: Schema.String,
    name: Schema.String
  })
])

const CreateClientBody = Schema.Struct({
  name: Schema.String,
  mayMutate: Schema.optional(Schema.Boolean)
})

const CreateGrantBody = Schema.Struct({
  clientId: Schema.String,
  alias: Schema.String,
  tool: Schema.String,
  connection: ConnectionRefBody,
  decision: Schema.optional(Schema.Literals(["allow", "require_approval"]))
})

const DecideApprovalBody = Schema.Struct({
  decidedBy: Schema.optional(Schema.String)
})

const DiscoverBody = Schema.Struct({
  url: Schema.String,
  connection: Schema.optional(Schema.String)
})

const ConnectBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  /** Credential values, resolved from the environment by the *client* before
   *  they get here. The gateway never reads a caller's environment. */
  values: Schema.optional(Schema.Record(Schema.String, Schema.String))
})

const OAuthStartBody = Schema.Struct({
  integration: Schema.String,
  connection: Schema.optional(Schema.String),
  template: Schema.optional(Schema.String),
  clientId: Schema.optional(Schema.String),
  clientSecret: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number)
})

const InvokeAddressBody = Schema.Struct({
  address: Schema.String,
  arguments: Schema.optional(Schema.Json)
})

const ValidateBody = Schema.Struct({
  node: Schema.Json,
  live: Schema.optional(Schema.Boolean)
})

/** The source form a workflow actually authors: an alias bound by a grant, not
 *  a catalog address. Validating it is a question about *this caller's* grants,
 *  which is why it is answered here rather than in the executor — the executor
 *  knows the catalog and nothing about delegation. */
const GatewayNodeSource = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literal("gateway"),
    alias: Schema.String,
    tool: Schema.String
  })
})

const isGatewayNode = Schema.is(GatewayNodeSource)
const decodeGatewayNode = Schema.decodeUnknownSync(GatewayNodeSource)

const toConnectionRef = (value: typeof ConnectionRefBody.Type): ConnectionRef =>
  value.owner === "org"
    ? {
      owner: "org",
      integration: IntegrationSlug.make(value.integration),
      name: ConnectionName.make(value.name)
    }
    : {
      owner: "user",
      subject: SubjectId.make(value.subject),
      integration: IntegrationSlug.make(value.integration),
      name: ConnectionName.make(value.name)
    }

const parseAlias = (value: string): Alias => {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`Alias "${value}" must be lowercase letters, digits, and dashes`)
  }
  return Alias.make(value)
}

const positiveInt = (value: string | null, fallback: number): number => {
  if (value === null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Compares connection names the way a human means them. The executor stores a
 *  normalised name (`docs-demo` becomes `docsDemo`), and rather than reproduce
 *  that transformation — which belongs to the executor and may change — this
 *  compares the parts a separator convention cannot alter. */
const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "")

const nonNegativeInt = (value: string | null, fallback: number): number => {
  if (value === null) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Answers the question a workflow author is actually asking: will this step
 *  resolve when it runs, as *this* caller? An alias is not a name in the
 *  catalog — it is a binding held by a grant — so structural validity and
 *  reachability are separate findings. */
const validateGatewayNode = async (
  dependencies: {
    readonly store: GatewayStore
    readonly executor: Pick<ExecutorServices, "tools">
  },
  clientId: ClientId,
  source: { readonly alias: string; readonly tool: string },
  live: boolean
): Promise<{
  readonly ok: boolean
  readonly findings: ReadonlyArray<
    { readonly severity: string; readonly check: string; readonly message: string }
  >
}> => {
  const findings: Array<{ severity: string; check: string; message: string }> = []
  const aliasIsWellFormed = /^[a-z][a-z0-9-]*$/.test(source.alias)
  findings.push(
    aliasIsWellFormed
      ? { severity: "info", check: "structural", message: "Gateway integration reference is valid" }
      : {
        severity: "error",
        check: "structural",
        message: `Alias "${source.alias}" must be lowercase letters, digits, and dashes`
      }
  )

  if (aliasIsWellFormed && live) {
    const grants = await dependencies.store.listGrants(clientId)
    const grant = grants.find((candidate) =>
      candidate.alias === source.alias && candidate.tool === source.tool
    )
    if (grant === undefined) {
      findings.push({
        severity: "error",
        check: "grant",
        // Naming the alias but not what else it exposes: a validation report is
        // not a place to enumerate a caller's other capabilities.
        message: `${source.alias}.${source.tool} is not granted to this key`
      })
    } else {
      findings.push({
        severity: "info",
        check: "grant",
        message: `${source.alias}.${source.tool} resolves to ${grant.connection.integration}/${grant.connection.name}${
          grant.decision === "require_approval" ? " and is frozen for a human" : ""
        }`
      })
      const address = grantToolAddress(grant.connection, grant.tool)
      const tools = await dependencies.executor.tools.list()
      findings.push(
        tools.some((candidate) => candidate.address === address)
          ? { severity: "info", check: "catalog", message: `${grant.tool} is available` }
          : {
            severity: "error",
            check: "catalog",
            message: `${grant.tool} is granted but no longer in the catalog: ${address}`
          }
      )
    }
  }

  return { ok: !findings.some((finding) => finding.severity === "error"), findings }
}

// --- routes -----------------------------------------------------------------

/** Picks the auth method a connect request should use, preferring an explicit
 *  template and otherwise the integration's only sensible option. */
const selectAuthMethod = (
  methods: ReadonlyArray<{ readonly id: string; readonly template: string; readonly kind: string }>,
  template: string | undefined
) => {
  if (template !== undefined) {
    const chosen = methods.find((method) => method.template === template || method.id === template)
    if (chosen === undefined) {
      throw new Error(
        `Unknown auth template "${template}". Available: ${methods.map((m) => m.template).join(", ")}`
      )
    }
    return chosen
  }
  if (methods.length === 0) return { id: "none", template: "none", kind: "none" }
  if (methods.length === 1) return methods[0]!
  const single = methods.find((method) => method.kind === "oauth") ?? methods[0]!
  return single
}

export const gatewayRoutes = (dependencies: ApiDependencies): ReadonlyArray<Route> => {
  const { store, executor, retentionDays, oauth } = dependencies

  return [
    // --- delegated: any live key -------------------------------------------
    {
      method: "GET",
      path: "/v1/tools",
      access: "delegated",
      handle: async (request) => ok({
        tools: await listGrantedTools(store, request.client.id, {
          schemas: request.query.get("schemas") === "true",
          executor
        })
      })
    },
    {
      method: "POST",
      path: "/v1/execute",
      access: "delegated",
      handle: async (request) => {
        const body = decodeBody(ExecuteBody, request.body)
        const outcome = await invokeThroughGateway(
          { store, executor, argumentRetentionDays: retentionDays },
          {
            secret: request.secret,
            alias: parseAlias(body.alias),
            tool: ToolName.make(body.tool),
            arguments: body.arguments ?? {}
          }
        )
        // A frozen call is not an error: the caller gets an identifier to poll,
        // and its branch of work suspends rather than failing.
        if (outcome.status === "denied") return { status: 403, body: outcome }
        if (outcome.status === "failed") return { status: 502, body: outcome }
        return ok(outcome)
      }
    },
    {
      method: "GET",
      path: "/v1/approvals/:id",
      access: "delegated",
      handle: async (request) => {
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        // Scoped to the caller: one client must not read another's frozen call.
        if (approval.clientId !== request.client.id) return notFound(`Unknown approval ${id}`)
        return ok(approval)
      }
    },

    // --- privileged: catalog and connections --------------------------------
    {
      method: "GET",
      path: "/v1/integrations",
      access: "privileged",
      handle: async () => ok({ integrations: await executor.listIntegrationOverviews() })
    },
    {
      method: "POST",
      path: "/v1/integrations/discover",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DiscoverBody, request.body)
        const result = await executor.provisioning.provision(
          body.url,
          body.connection === undefined ? {} : { connection: body.connection }
        )
        return created(result)
      }
    },
    {
      method: "GET",
      path: "/v1/integrations/:slug/tools",
      access: "privileged",
      handle: async (request) => ok({
        tools: await executor.tools.summaries({ integration: request.params["slug"] ?? "" })
      })
    },
    {
      method: "GET",
      path: "/v1/integrations/:slug/tools/:tool",
      access: "privileged",
      handle: async (request) => {
        const connection = request.query.get("connection")
        const tool = await executor.tools.describe({
          integration: request.params["slug"] ?? "",
          name: request.params["tool"] ?? "",
          ...whenPresent("connection", connection)
        })
        return ok(tool)
      }
    },
    {
      method: "GET",
      path: "/v1/registry/search",
      access: "privileged",
      handle: async (request) => {
        const query = request.query.get("q")
        if (query === null) return badRequest("search requires a q query parameter")
        const kind = request.query.get("kind")
        return ok(await searchIntegrations(
          {
            q: query,
            limit: positiveInt(request.query.get("limit"), 5),
            ...whenPresentMap(
              "kind",
              kind,
              Schema.decodeUnknownSync(Schema.Literals(["mcp", "openapi", "graphql", "cli"]))
            )
          },
          whenPresent("registryUrl", dependencies.registryUrl)
        ))
      }
    },
    {
      method: "POST",
      path: "/v1/tools/invoke",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(InvokeAddressBody, request.body)
        // Privileged, and deliberately not grant-checked: a client that may
        // mutate grants could grant itself this tool in one extra call, so a
        // check here would be friction rather than a control. The delegated
        // surface has no address form at all. See docs/adr/0002.
        const result = await executor.tools.execute(
          ExecutorToolAddress.make(body.address),
          body.arguments ?? {}
        )
        return ok(result)
      }
    },
    {
      method: "POST",
      path: "/v1/validate",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(ValidateBody, request.body)
        if (isGatewayNode(body.node)) {
          return ok(await validateGatewayNode(
            { store, executor },
            request.client.id,
            decodeGatewayNode(body.node).source,
            body.live ?? true
          ))
        }
        return ok(await executor.validateIntegrationNode(body.node, { live: body.live ?? true }))
      }
    },
    {
      method: "GET",
      path: "/v1/connections",
      access: "privileged",
      handle: async () => ok({ connections: await executor.connections.list() })
    },
    {
      method: "POST",
      path: "/v1/connections",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(ConnectBody, request.body)
        const integration = await executor.catalog.find(body.integration)
        if (integration === undefined) return notFound(`Unknown integration ${body.integration}`)
        const method = selectAuthMethod(integration.authMethods, body.template)
        if (method.kind === "oauth") {
          return badRequest(
            `${integration.slug} uses OAuth; start it at POST /v1/connections/oauth`
          )
        }
        const values = body.values ?? {}
        const names = Object.keys(values)
        const connection = await executor.connections.create({
          integration: integration.slug,
          name: body.connection ?? "default",
          template: method.template,
          ...(names.length === 0
            ? { value: "" }
            : names.length === 1 && values["token"] !== undefined
            ? { value: values["token"] }
            : { values })
        })
        return created({
          connection,
          tools: await executor.tools.summaries({
            integration: integration.slug,
            connection: connection.name
          })
        })
      }
    },
    {
      method: "POST",
      path: "/v1/connections/oauth",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(OAuthStartBody, request.body)
        const integration = await executor.catalog.find(body.integration)
        if (integration === undefined) return notFound(`Unknown integration ${body.integration}`)
        const method = integration.authMethods.find((candidate) =>
          body.template === undefined
            ? candidate.kind === "oauth"
            : candidate.template === body.template || candidate.id === body.template
        )
        if (method === undefined || method.kind !== "oauth") {
          return badRequest(`${integration.slug} has no OAuth auth method`)
        }
        // The gateway drives the flow and hosts the callback, because it is
        // what holds credentials. The caller opens a browser and polls.
        const session = await oauth.start({
          integration: integration.slug,
          connection: body.connection ?? "default",
          authMethod: method,
          ...whenPresent("clientId", body.clientId),
          ...whenPresent("clientSecret", body.clientSecret),
          ...whenPresentMap("timeoutMs", body.timeoutSeconds, (seconds) => Math.max(1, seconds) * 1000)
        })
        return created(session)
      }
    },
    {
      method: "GET",
      path: "/v1/connections/oauth/:id",
      access: "privileged",
      handle: async (request) => {
        const session = oauth.get(request.params["id"] ?? "")
        if (session === undefined) return notFound("Unknown or expired OAuth session")
        return ok(session)
      }
    },
    {
      method: "DELETE",
      path: "/v1/connections/:integration/:name",
      access: "privileged",
      handle: async (request) => {
        const integration = request.params["integration"] ?? ""
        const requested = request.params["name"] ?? ""
        // Connection names are normalised on the way in (`docs-demo` is stored
        // as `docsDemo`), so removing one by the name you typed has to resolve
        // through the same normalisation. Otherwise a connection you just made
        // cannot be deleted by the name you made it with.
        const connections = await executor.connections.list()
        const match = connections.find((connection) =>
          connection.integration === integration &&
          (connection.name === requested || normalizeName(connection.name) === normalizeName(requested))
        )
        if (match === undefined) {
          const known = connections
            .filter((connection) => connection.integration === integration)
            .map((connection) => connection.name)
          return notFound(
            known.length === 0
              ? `${integration} has no connections`
              : `${integration} has no connection ${requested}. Known: ${known.join(", ")}`
          )
        }
        await executor.connections.remove({ integration, name: match.name })
        return ok({ removed: true, integration, connection: match.name })
      }
    },

    // --- privileged: clients, keys, grants ----------------------------------
    {
      method: "GET",
      path: "/v1/clients",
      access: "privileged",
      handle: async () => ok({ clients: await store.listClients() })
    },
    {
      method: "POST",
      path: "/v1/clients",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(CreateClientBody, request.body)
        if (await store.findClientByName(body.name) !== undefined) {
          return badRequest(`A client named ${body.name} already exists`)
        }
        const client = await store.createClient({
          id: newClientId(),
          name: body.name,
          mayMutate: body.mayMutate ?? false
        })
        return created(client)
      }
    },
    {
      method: "POST",
      path: "/v1/clients/:id/keys",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        const key = generateApiKey()
        await store.addApiKey({ id: key.id, clientId, hash: key.hash })
        // The only time the plaintext exists outside the caller's hands.
        return created({ id: key.id, clientId, secret: key.secret })
      }
    },
    {
      method: "GET",
      path: "/v1/clients/:id/keys",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        // Hashes stay behind the gateway. What an operator needs is which keys
        // exist, when each was last used, and which are still live.
        const keys = await store.listApiKeys(clientId)
        return ok({
          keys: keys.map((key) => ({
            id: key.id,
            clientId: key.clientId,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
            revokedAt: key.revokedAt
          }))
        })
      }
    },
    {
      method: "POST",
      path: "/v1/keys/:id/revoke",
      access: "privileged",
      handle: async (request) => {
        const keyId = ApiKeyId.make(request.params["id"] ?? "")
        await store.revokeApiKey(keyId)
        // Rotation, not containment: a revoked key's frozen calls stay armed
        // because the client behind them is still trusted. Revoking the client
        // is what cancels those.
        return ok({ revoked: true, key: keyId })
      }
    },
    {
      method: "GET",
      path: "/v1/clients/:id/tools",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        // The same listing `/v1/tools` gives a key about itself, asked about
        // someone else. Generating bindings for the client you are
        // provisioning should not require holding its key.
        return ok({
          tools: await listGrantedTools(store, clientId, {
            schemas: request.query.get("schemas") === "true",
            executor
          })
        })
      }
    },
    {
      method: "POST",
      path: "/v1/clients/:id/revoke",
      access: "privileged",
      handle: async (request) => {
        const clientId = ClientId.make(request.params["id"] ?? "")
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        await store.revokeClient(clientId)
        // Revoking a client is done because something is wrong, so its frozen
        // actions must not stay armed. Revoking a single key does not do this.
        const cancelled = await store.cancelApprovalsForClient(clientId)
        return ok({ revoked: true, cancelledApprovals: cancelled })
      }
    },
    {
      method: "GET",
      path: "/v1/grants",
      access: "privileged",
      handle: async (request) => {
        const clientId = request.query.get("clientId")
        if (clientId === null) return badRequest("grants require a clientId query parameter")
        return ok({ grants: await store.listGrants(ClientId.make(clientId)) })
      }
    },
    {
      method: "POST",
      path: "/v1/grants",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(CreateGrantBody, request.body)
        const clientId = ClientId.make(body.clientId)
        if (await store.findClientById(clientId) === undefined) {
          return notFound(`Unknown client ${clientId}`)
        }
        if (body.connection.owner === "user") {
          // The wire contract keeps the user tier because that is where the
          // design is going, but nothing can create a user-tier *connection*
          // yet, so such a grant resolves to an address that does not exist. A
          // grant that can only fail at invoke time is worse than a refusal
          // here.
          return badRequest(
            "User-tier connections do not exist yet, so a user-tier grant cannot resolve. Grant against an org connection."
          )
        }
        const grant = await store.createGrant({
          id: newGrantId(),
          clientId,
          alias: parseAlias(body.alias),
          tool: ToolName.make(body.tool),
          connection: toConnectionRef(body.connection),
          decision: body.decision ?? "allow"
        })
        return created(grant)
      }
    },
    {
      method: "POST",
      path: "/v1/grants/:id/revoke",
      access: "privileged",
      handle: async (request) => {
        await store.revokeGrant(GrantId.make(request.params["id"] ?? ""))
        return ok({ revoked: true })
      }
    },

    // --- privileged: approvals, audit ---------------------------------------
    {
      method: "GET",
      path: "/v1/approvals",
      access: "privileged",
      handle: async (request) => {
        const status = request.query.get("status")
        return ok({
          approvals: status === null
            ? await store.listApprovals()
            : await store.listApprovals(
              Schema.decodeUnknownSync(
                Schema.Literals(["pending", "approved", "denied", "expired"])
              )(status)
            )
        })
      }
    },
    {
      method: "POST",
      path: "/v1/approvals/:id/approve",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DecideApprovalBody, request.body ?? {})
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        if (approval.status !== "pending") {
          return badRequest(`Approval ${id} is already ${approval.status}`)
        }
        if (approval.expiresAt.getTime() <= Date.now()) {
          await store.settleApproval({
            id,
            status: "expired",
            decidedBy: null,
            result: null,
            error: "expired before a decision was recorded"
          })
          // Expiry is a decision, not an absence of one.
          return badRequest(`Approval ${id} expired`)
        }

        const client = await store.findClientById(approval.clientId)
        const grants = await store.listGrants(approval.clientId)
        const grant = grants.find((candidate) => candidate.id === approval.grantId)
        if (client === undefined || client.revokedAt !== null || grant === undefined) {
          await store.settleApproval({
            id,
            status: "denied",
            decidedBy: body.decidedBy ?? null,
            result: null,
            error: "the client or grant was revoked while this call was frozen"
          })
          return badRequest(`Approval ${id} is no longer authorized`)
        }

        // The gateway performs the call. The caller is never handed the ability
        // to perform it, so approving confers no capability.
        const outcome = await executeAuthorized(
          { store, executor, retentionDays },
          {
            status: "authorized",
            client,
            grant,
            connection: grant.connection,
            subject: grant.connection.owner === "user" ? grant.connection.subject : null
          },
          approval.arguments
        )
        await store.settleApproval({
          id,
          status: "approved",
          decidedBy: body.decidedBy ?? null,
          result: outcome.status === "succeeded" ? outcome.result : null,
          error: outcome.status === "failed" ? outcome.message : null
        })
        return ok({ approval: await store.getApproval(id), outcome })
      }
    },
    {
      method: "POST",
      path: "/v1/approvals/:id/deny",
      access: "privileged",
      handle: async (request) => {
        const body = decodeBody(DecideApprovalBody, request.body ?? {})
        const id = ApprovalId.make(request.params["id"] ?? "")
        const approval = await store.getApproval(id)
        if (approval === undefined) return notFound(`Unknown approval ${id}`)
        await store.settleApproval({
          id,
          status: "denied",
          decidedBy: body.decidedBy ?? null,
          result: null,
          error: null
        })
        return ok({ approval: await store.getApproval(id) })
      }
    },
    {
      method: "POST",
      path: "/v1/drift/refresh",
      access: "privileged",
      handle: async (request) => {
        const slug = request.query.get("integration")
        const integrations = slug === null
          ? (await executor.catalog.list()).map((entry) => entry.slug)
          : [slug]
        const reports = []
        for (const integration of integrations) {
          reports.push(await refreshIntegrationSnapshot({ store, executor }, integration))
        }
        return ok({ reports })
      }
    },
    {
      method: "POST",
      path: "/v1/maintenance",
      access: "privileged",
      handle: async () => ok(await runMaintenance(store))
    },
    {
      method: "GET",
      path: "/v1/audit",
      access: "privileged",
      handle: async (request) => {
        const since = request.query.get("since")
        const sinceDate = since === null ? undefined : new Date(since)
        if (sinceDate !== undefined && Number.isNaN(sinceDate.getTime())) {
          return badRequest(`since is not a date: ${since}`)
        }
        const outcome = request.query.get("outcome")
        const clientId = request.query.get("clientId")
        const alias = request.query.get("alias")
        const tool = request.query.get("tool")
        const filter = {
          ...whenPresentMap("clientId", clientId, ClientId.make),
          ...whenPresentMap("alias", alias, Alias.make),
          ...whenPresentMap("tool", tool, ToolName.make),
          ...whenPresentMap(
            "outcome",
            outcome,
            Schema.decodeUnknownSync(Schema.Literals(["succeeded", "failed", "denied", "pending"]))
          ),
          ...whenPresent("since", sinceDate)
        }
        const limit = positiveInt(request.query.get("limit"), 50)
        const offset = nonNegativeInt(request.query.get("offset"), 0)
        // The trail is permanent, so the count is what tells a reader whether
        // the window they asked for is the whole answer.
        return ok({
          records: await store.listAudit({ ...filter, limit, offset }),
          total: await store.countAudit(filter),
          limit,
          offset
        })
      }
    }
  ]
}
