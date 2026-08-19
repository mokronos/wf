import { whenPresent } from "@mokronos/wfkit"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor"
import type {
  ExecutorConnection,
  ExecutorServices,
  ExecutorTool
} from "@mokronos/wfkit-executor"
import {
  Alias,
  ClientId,
  ConnectionName,
  createGatewayHandler,
  createGatewayStore,
  generateApiKey,
  IntegrationSlug,
  gatewayRoutes,
  newClientId,
  newGrantId,
  SubjectId,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore } from "../src/index.ts"

const JsonBody = Schema.Record(Schema.String, Schema.Json)

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const connection: ConnectionRef = {
  owner: "user",
  subject: SubjectId.make("sebastian"),
  integration: IntegrationSlug.make("gmail"),
  name: ConnectionName.make("work")
}

interface ExecutedCall {
  readonly address: string
  readonly input: typeof Schema.Json.Type
}

/** Members these tests never reach. Throwing is deliberate: a partial fake that
 *  returned `undefined` would let a handler quietly start depending on one of
 *  these and still pass. */
const notStubbed = (member: string) => () => {
  throw new Error(`stubExecutor: ${member} is not stubbed for these tests`)
}

/** Fills in the fields a vendor connection always carries so a test only has to
 *  name the part it cares about. */
const stubConnection = (
  reference: { readonly integration: string; readonly name: string }
): ExecutorConnection => ({
  owner: "user",
  name: reference.name,
  integration: reference.integration,
  template: reference.integration,
  address: `connections.${reference.integration}.user.${reference.name}`,
  provider: reference.integration
})

/** Fills in a tool's descriptive fields, which these tests never assert on. */
const stubTool = (
  tool: { readonly address: string; readonly name: string }
): ExecutorTool => ({
  address: ExecutorToolAddress.make(tool.address),
  name: tool.name,
  description: "",
  integration: "gmail",
  owner: "user",
  connection: "work"
})

/** A stand-in for the Executor tool surface. The gateway's job is deciding
 *  whether a call happens and with which credential — not what the vendor
 *  returns — so the tests assert on which address was reached. */
const stubExecutor = (behaviour: {
  readonly fail?: boolean
  readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
  readonly tools?: ReadonlyArray<{ readonly address: string; readonly name: string }>
} = {}) => {
  const calls: Array<ExecutedCall> = []
  const removed: Array<{ readonly integration: string; readonly name: string }> = []
  const executor: ExecutorServices = {
    tools: {
      execute: async (address, input) => {
        calls.push({ address: String(address), input })
        if (behaviour.fail === true) throw new Error("vendor exploded")
        return { ok: true }
      },
      summaries: async () => [],
      describe: notStubbed("tools.describe"),
      list: async () => (behaviour.tools ?? []).map(stubTool)
    },
    connections: {
      list: async () => (behaviour.connections ?? []).map(stubConnection),
      remove: async (reference) => {
        removed.push({ integration: reference.integration, name: reference.name })
      },
      create: notStubbed("connections.create"),
      ensure: notStubbed("connections.ensure")
    },
    catalog: {
      detectIntegration: notStubbed("catalog.detectIntegration"),
      probeMcp: notStubbed("catalog.probeMcp"),
      previewOpenApi: notStubbed("catalog.previewOpenApi"),
      list: notStubbed("catalog.list"),
      find: notStubbed("catalog.find"),
      addMcp: notStubbed("catalog.addMcp"),
      addOpenApi: notStubbed("catalog.addOpenApi")
    },
    auth: {
      probe: notStubbed("auth.probe"),
      registerClient: notStubbed("auth.registerClient"),
      createClient: notStubbed("auth.createClient"),
      start: notStubbed("auth.start"),
      complete: notStubbed("auth.complete")
    },
    discovery: { inspect: notStubbed("discovery.inspect") },
    provisioning: {
      install: notStubbed("provisioning.install"),
      provision: notStubbed("provisioning.provision")
    },
    validateIntegrationNode: notStubbed("validateIntegrationNode"),
    listIntegrationOverviews: async () => []
  }
  return { calls, removed, executor }
}

const setup = async (options: {
  readonly decision?: "allow" | "require_approval"
  readonly mayMutate?: boolean
  readonly fail?: boolean
  readonly connections?: ReadonlyArray<{ readonly integration: string; readonly name: string }>
  readonly tools?: ReadonlyArray<{ readonly address: string; readonly name: string }>
} = {}) => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-http-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "gateway.sqlite"))
  stores.push(store)

  const client = await store.createClient({
    id: newClientId(),
    name: "support-agent",
    mayMutate: options.mayMutate ?? false
  })
  const key = generateApiKey()
  await store.addApiKey({ id: key.id, clientId: client.id, hash: key.hash })
  const grant = await store.createGrant({
    id: newGrantId(),
    clientId: client.id,
    alias: Alias.make("gmail-work"),
    tool: ToolName.make("sendEmail"),
    connection,
    decision: options.decision ?? "allow"
  })

  const stub = stubExecutor({
    ...whenPresent("fail", options.fail),
    ...whenPresent("connections", options.connections),
    ...whenPresent("tools", options.tools)
  })
  const handle = createGatewayHandler({
    store,
    routes: gatewayRoutes({
      store,
      executor: stub.executor,
      retentionDays: 30,
      // No OAuth flow is exercised here; these tests are about authority.
      oauth: {
        start: async () => { throw new Error("not used") },
        get: () => undefined,
        stop: () => undefined
      }
    })
  })

  const call = async (
    method: string,
    pathname: string,
    init: { readonly body?: unknown; readonly secret?: string | null } = {}
  ) => {
    const secret = init.secret === undefined ? key.secret : init.secret
    const headers = secret === null
      ? { "content-type": "application/json" }
      : { "content-type": "application/json", authorization: `Bearer ${secret}` }
    const response = await handle(new Request(`http://gateway.test${pathname}`, {
      method,
      headers,
      ...whenPresent("body", JSON.stringify(init.body))
    }))
    return {
      status: response.status,
      body: Schema.decodeUnknownSync(JsonBody)(await response.json())
    }
  }

  return { store, client, key, grant, call, calls: stub.calls, removed: stub.removed }
}

describe("gateway http surface", () => {
  test("serves health without a key", async () => {
    const { call } = await setup()
    const response = await call("GET", "/v1/health", { secret: null })
    expect(response.status).toBe(200)
  })

  test("requires a key on every other route", async () => {
    const { call } = await setup()
    expect((await call("GET", "/v1/tools", { secret: null })).status).toBe(401)
  })

  test("rejects an unknown key with 401 and a revoked client with 403", async () => {
    const { call, client, store } = await setup()
    expect((await call("GET", "/v1/tools", { secret: "wfi_nope" })).status).toBe(401)

    await store.revokeClient(client.id)
    expect((await call("GET", "/v1/tools")).status).toBe(403)
  })

  test("distinguishes an unknown path from a wrong method", async () => {
    const { call } = await setup()
    expect((await call("GET", "/v1/nothing")).status).toBe(404)
    expect((await call("DELETE", "/v1/tools")).status).toBe(405)
  })

  test("lists only the tools the caller was granted", async () => {
    const { call } = await setup()
    const response = await call("GET", "/v1/tools")
    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      { alias: "gmail-work", tool: "sendEmail", integration: "gmail", decision: "allow" }
    ])
  })

  test("executes a granted tool against the address built from the grant", async () => {
    const { call, calls } = await setup()

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("succeeded")
    // The address is derived from the grant, so a caller cannot forge one.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.address).toBe("tools.gmail.user.work.sendEmail")
  })

  test("refuses an ungranted tool without calling the vendor", async () => {
    const { call, calls } = await setup()

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "deleteEverything" }
    })

    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test("freezes a require_approval call instead of performing it", async () => {
    const { call, calls } = await setup({ decision: "require_approval" })

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })

    expect(response.status).toBe(200)
    expect(response.body["status"]).toBe("pending")
    expect(response.body["approvalId"]).toBeString()
    // Nothing reached the vendor: the call is frozen, not attempted.
    expect(calls).toHaveLength(0)
  })

  test("reports a vendor failure as 502 rather than a denial", async () => {
    const { call } = await setup({ fail: true })

    const response = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })

    expect(response.status).toBe(502)
    expect(response.body["status"]).toBe("failed")
  })

  test("rejects a malformed body at the boundary", async () => {
    const { call } = await setup()
    const response = await call("POST", "/v1/execute", { body: { alias: "gmail-work" } })
    expect(response.status).toBe(400)
  })

  test("refuses privileged routes to a key that may not mutate", async () => {
    const { call } = await setup({ mayMutate: false })

    for (const [method, route] of [
      ["GET", "/v1/integrations"],
      ["POST", "/v1/integrations/discover"],
      ["GET", "/v1/connections"],
      ["GET", "/v1/clients"],
      ["POST", "/v1/clients"],
      ["GET", "/v1/grants?clientId=x"],
      ["POST", "/v1/grants"],
      ["GET", "/v1/approvals"],
      ["GET", "/v1/audit"]
    ] as const) {
      const response = await call(method, route, { body: {} })
      expect(`${route} -> ${response.status}`).toBe(`${route} -> 403`)
    }
  })

  test("permits the same routes to a key that may mutate", async () => {
    const { call } = await setup({ mayMutate: true })
    expect((await call("GET", "/v1/integrations")).status).toBe(200)
    expect((await call("GET", "/v1/clients")).status).toBe(200)
    expect((await call("GET", "/v1/audit")).status).toBe(200)
  })

  test("does not let one client read another's frozen call", async () => {
    const { call, store, client } = await setup({ decision: "require_approval" })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    const other = await store.createClient({
      id: newClientId(),
      name: "someone-else",
      mayMutate: false
    })
    const otherKey = generateApiKey()
    await store.addApiKey({ id: otherKey.id, clientId: other.id, hash: otherKey.hash })

    expect((await call("GET", `/v1/approvals/${approvalId}`)).status).toBe(200)
    const peek = await call("GET", `/v1/approvals/${approvalId}`, { secret: otherKey.secret })
    // Reported as absent rather than forbidden, so existence does not leak.
    expect(peek.status).toBe(404)
    expect(client.id).not.toBe(other.id)
  })

  test("issues a key exactly once and never returns it again", async () => {
    const { call, store } = await setup({ mayMutate: true })
    const clientResponse = await call("POST", "/v1/clients", { body: { name: "sandbox" } })
    expect(clientResponse.status).toBe(201)
    const clientId = ClientId.make(String(clientResponse.body["id"]))

    const keyResponse = await call("POST", `/v1/clients/${clientId}/keys`, { body: {} })
    expect(keyResponse.status).toBe(201)
    const secret = String(keyResponse.body["secret"])
    expect(secret).toStartWith("wfi_")

    const stored = await store.listApiKeys(clientId)
    expect(JSON.stringify(stored)).not.toContain(secret)
  })

  test("a new client defaults to not being able to mutate", async () => {
    const { call } = await setup({ mayMutate: true })
    const response = await call("POST", "/v1/clients", { body: { name: "sandbox" } })
    expect(response.body["mayMutate"]).toBe(false)
  })

  test("revoking a client through the API cancels its frozen calls", async () => {
    const { call, client } = await setup({ decision: "require_approval", mayMutate: true })
    await call("POST", "/v1/execute", { body: { alias: "gmail-work", tool: "sendEmail" } })

    const response = await call("POST", `/v1/clients/${client.id}/revoke`, { body: {} })

    expect(response.status).toBe(200)
    expect(response.body["cancelledApprovals"]).toBe(1)
  })
})

describe("gateway approval settlement", () => {
  test("the gateway performs the call itself once approved", async () => {
    const { call, calls } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })
    const approvalId = String(frozen.body["approvalId"])
    expect(calls).toHaveLength(0)

    const approved = await call("POST", `/v1/approvals/${approvalId}/approve`, {
      body: { decidedBy: "sebastian" }
    })

    expect(approved.status).toBe(200)
    // Approving discharges one frozen invocation. The caller was never handed
    // the capability, and the frozen arguments are what ran.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toEqual({ to: "a@b.c" })
  })

  test("refuses to approve twice", async () => {
    const { call } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    expect((await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })).status).toBe(200)
    expect((await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })).status).toBe(400)
  })

  test("refuses to approve a call whose grant was revoked while frozen", async () => {
    const { call, store, grant, calls } = await setup({
      decision: "require_approval",
      mayMutate: true
    })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    await store.revokeGrant(grant.id)
    const approved = await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })

    expect(approved.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("denying settles without performing the call", async () => {
    const { call, calls } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail" }
    })
    const approvalId = String(frozen.body["approvalId"])

    const denied = await call("POST", `/v1/approvals/${approvalId}/deny`, {
      body: { decidedBy: "sebastian" }
    })

    expect(denied.status).toBe(200)
    expect(calls).toHaveLength(0)
  })
})

describe("frozen calls and retries", () => {
  const send = (
    call: Awaited<ReturnType<typeof setup>>["call"],
    args: Record<string, typeof Schema.Json.Type> = { to: "a@b.c" }
  ) => call("POST", "/v1/execute", {
    body: { alias: "gmail-work", tool: "sendEmail", arguments: args }
  })

  test("a retry meets the frozen call it already proposed", async () => {
    const { call, store } = await setup({ decision: "require_approval", mayMutate: true })

    const first = await send(call)
    const second = await send(call)
    // Key order is an artefact of how the caller built its JSON, not part of
    // what it asked for.
    const third = await call("POST", "/v1/execute", {
      body: { alias: "gmail-work", tool: "sendEmail", arguments: { to: "a@b.c" } }
    })

    expect(second.body["approvalId"]).toBe(first.body["approvalId"])
    expect(third.body["approvalId"]).toBe(first.body["approvalId"])
    // One decision to make, however many times the caller retried.
    expect(await store.listApprovals("pending")).toHaveLength(1)
  })

  test("different arguments are a different frozen call", async () => {
    const { call, store } = await setup({ decision: "require_approval", mayMutate: true })

    const first = await send(call, { to: "a@b.c" })
    const second = await send(call, { to: "someone-else@b.c" })

    expect(second.body["approvalId"]).not.toBe(first.body["approvalId"])
    expect(await store.listApprovals("pending")).toHaveLength(2)
  })

  test("the retry after approval collects the result exactly once", async () => {
    const { call, store, calls } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await send(call)
    const approvalId = String(frozen.body["approvalId"])
    await call("POST", `/v1/approvals/${approvalId}/approve`, { body: {} })
    // The gateway performed it at approval time, not on the caller's behalf.
    expect(calls).toHaveLength(1)

    const collected = await send(call)
    expect(collected.body["status"]).toBe("succeeded")
    expect(collected.body["result"]).toEqual({ ok: true })
    expect(calls).toHaveLength(1)

    // And the call after that is a new request, so it needs its own decision
    // rather than replaying a "yes" forever.
    const afterCollection = await send(call)
    expect(afterCollection.body["status"]).toBe("pending")
    expect(afterCollection.body["approvalId"]).not.toBe(approvalId)
    expect(await store.listApprovals("pending")).toHaveLength(1)
  })

  test("a denial is delivered to the caller rather than left pending forever", async () => {
    const { call } = await setup({ decision: "require_approval", mayMutate: true })
    const frozen = await send(call)
    const approvalId = String(frozen.body["approvalId"])
    await call("POST", `/v1/approvals/${approvalId}/deny`, { body: { decidedBy: "sebastian" } })

    const collected = await send(call)

    expect(collected.status).toBe(403)
    expect(collected.body["status"]).toBe("denied")
    expect(String(collected.body["reason"])).toContain("sebastian")
  })

  test("the caller can read its own frozen call without a privileged key", async () => {
    const { call } = await setup({ decision: "require_approval" })
    const frozen = await send(call)

    const polled = await call("GET", `/v1/approvals/${String(frozen.body["approvalId"])}`)

    expect(polled.status).toBe(200)
    expect(polled.body["status"]).toBe("pending")
    expect(polled.body["collectedAt"]).toBeNull()
  })
})

describe("provisioning surface", () => {
  test("validates the node shape a workflow actually authors", async () => {
    const { call } = await setup({
      mayMutate: true,
      tools: [{ address: "tools.gmail.user.work.sendEmail", name: "sendEmail" }]
    })

    const report = await call("POST", "/v1/validate", {
      body: { node: { source: { kind: "gateway", alias: "gmail-work", tool: "sendEmail" } } }
    })

    expect(report.status).toBe(200)
    expect(report.body["ok"]).toBe(true)
    const checks = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ check: Schema.String }))
    )(report.body["findings"]).map((finding) => finding.check)
    expect(checks).toEqual(["structural", "grant", "catalog"])
  })

  test("reports an alias this key does not hold", async () => {
    const { call } = await setup({ mayMutate: true })

    const report = await call("POST", "/v1/validate", {
      body: { node: { source: { kind: "gateway", alias: "gmail-work", tool: "deleteEverything" } } }
    })

    expect(report.body["ok"]).toBe(false)
    expect(JSON.stringify(report.body)).toContain("not granted")
  })

  test("refuses a grant against a connection tier that cannot exist", async () => {
    const { call, client } = await setup({ mayMutate: true })

    const response = await call("POST", "/v1/grants", {
      body: {
        clientId: client.id,
        alias: "gmail-personal",
        tool: "sendEmail",
        connection: {
          owner: "user",
          subject: "sebastian",
          integration: "gmail",
          name: "personal"
        }
      }
    })

    // Better a refusal here than a grant that can only fail at invoke time.
    expect(response.status).toBe(400)
    expect(String(response.body["error"])).toContain("User-tier")
  })

  test("removes a connection by the name it was asked for, not the stored one", async () => {
    const { call, removed } = await setup({
      mayMutate: true,
      connections: [{ integration: "gmail", name: "docsDemo" }]
    })

    const response = await call("DELETE", "/v1/connections/gmail/docs-demo")

    expect(response.status).toBe(200)
    expect(response.body["connection"]).toBe("docsDemo")
    expect(removed).toEqual([{ integration: "gmail", name: "docsDemo" }])
  })

  test("says which connections exist when none matches", async () => {
    const { call } = await setup({
      mayMutate: true,
      connections: [{ integration: "gmail", name: "work" }]
    })

    const response = await call("DELETE", "/v1/connections/gmail/personal")

    expect(response.status).toBe(404)
    expect(String(response.body["error"])).toContain("work")
  })

  test("lists a client's keys without their hashes, and revokes one", async () => {
    const { call, client, key, store } = await setup({ mayMutate: true })

    const listed = await call("GET", `/v1/clients/${client.id}/keys`)
    const keys = Schema.decodeUnknownSync(Schema.Array(JsonBody))(listed.body["keys"])
    expect(keys).toHaveLength(1)
    expect(keys[0]?.["id"]).toBe(key.id)
    expect(JSON.stringify(keys)).not.toContain(key.hash)

    const revoked = await call("POST", `/v1/keys/${key.id}/revoke`)
    expect(revoked.status).toBe(200)
    const after = await store.listApiKeys(client.id)
    expect(after[0]?.revokedAt).not.toBeNull()
  })

  test("reads another client's granted surface, so codegen does not need its key", async () => {
    const { call, client } = await setup({ mayMutate: true })

    const response = await call("GET", `/v1/clients/${client.id}/tools`)

    expect(response.status).toBe(200)
    expect(response.body["tools"]).toEqual([
      { alias: "gmail-work", tool: "sendEmail", integration: "gmail", decision: "allow" }
    ])
  })

  test("filters and windows the audit trail, and says how much there is", async () => {
    const { call } = await setup({ mayMutate: true })
    await call("POST", "/v1/execute", { body: { alias: "gmail-work", tool: "sendEmail" } })
    await call("POST", "/v1/execute", { body: { alias: "gmail-work", tool: "nope" } })

    const all = await call("GET", "/v1/audit")
    expect(all.body["total"]).toBe(2)

    const denied = await call("GET", "/v1/audit?outcome=denied")
    expect(denied.body["total"]).toBe(1)
    expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(denied.body["records"])).toHaveLength(1)

    const windowed = await call("GET", "/v1/audit?limit=1&offset=1")
    expect(windowed.body["total"]).toBe(2)
    expect(windowed.body["offset"]).toBe(1)
    expect(Schema.decodeUnknownSync(Schema.Array(Schema.Json))(windowed.body["records"])).toHaveLength(1)
  })
})
