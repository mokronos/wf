import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ExecutorToolAddress } from "@mokronos/wfkit-executor"
import type { ExecutorTool } from "@mokronos/wfkit-executor"
import {
  Alias,
  ConnectionName,
  createGatewayStore,
  diffSnapshots,
  IntegrationSlug,
  newApprovalId,
  newAuditId,
  newClientId,
  newGrantId,
  refreshIntegrationSnapshot,
  runMaintenance,
  ToolName
} from "../src/index.ts"
import type { ConnectionRef, GatewayStore, ToolCatalogReader, ToolSnapshot } from "../src/index.ts"

const directories: Array<string> = []
const stores: Array<GatewayStore> = []

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

const makeStore = async (): Promise<GatewayStore> => {
  const directory = await mkdtemp(path.join(tmpdir(), "wf-gateway-drift-"))
  directories.push(directory)
  const store = await createGatewayStore(path.join(directory, "gateway.sqlite"))
  stores.push(store)
  return store
}

const snapshot = (tool: string, input: ToolSnapshot["inputSchema"]): ToolSnapshot => ({
  integration: IntegrationSlug.make("tickets"),
  connection: ConnectionName.make("default"),
  tool: ToolName.make(tool),
  inputSchema: input,
  outputSchema: null,
  syncedAt: new Date()
})

/** Stands in for a vendor whose catalog we do not control. Satisfying
 *  `ToolCatalogReader` rather than the whole Executor surface is what lets this
 *  build a real, fully typed tool list without casting. */
const executorWithTools = (
  tools: ReadonlyArray<{ name: string; input: ExecutorTool["inputSchema"] }>
): ToolCatalogReader => ({
  tools: {
    list: async () =>
      tools.map((tool) => ({
        address: ExecutorToolAddress.make(`tools.tickets.org.default.${tool.name}`),
        name: tool.name,
        description: "",
        integration: "tickets",
        owner: "org",
        connection: "default",
        inputSchema: tool.input
      }))
  }
})

describe("catalog drift", () => {
  test("reports nothing when a vendor has not moved", () => {
    const before = [snapshot("create", { type: "object" })]
    expect(diffSnapshots(before, before)).toEqual([])
  })

  test("reports a rename as one removal and one addition", () => {
    const entries = diffSnapshots(
      [snapshot("send_email", null)],
      [snapshot("sendEmail", null)]
    )

    expect(entries.map((entry) => `${entry.kind} ${entry.tool}`).sort()).toEqual([
      "added sendEmail",
      "removed send_email"
    ])
  })

  test("reports a reshaped schema under the same name", () => {
    const entries = diffSnapshots(
      [snapshot("create", { type: "object" })],
      [snapshot("create", { type: "string" })]
    )

    expect(entries).toEqual([
      {
        kind: "changed",
        integration: IntegrationSlug.make("tickets"),
        connection: ConnectionName.make("default"),
        tool: ToolName.make("create")
      }
    ])
  })

  test("surfaces new tools, which explicit grants otherwise make invisible", async () => {
    const store = await makeStore()
    // The first sync has nothing to compare against, so it records the shape
    // and reports a baseline. Calling an integration's entire surface "added"
    // would bury the one real change in the run that matters.
    const first = await refreshIntegrationSnapshot(
      { store, executor: executorWithTools([{ name: "create", input: null }]) },
      "tickets"
    )
    expect(first.baseline).toBe(true)
    expect(first.entries).toEqual([])

    const second = await refreshIntegrationSnapshot(
      {
        store,
        executor: executorWithTools([
          { name: "create", input: null },
          { name: "deleteEverything", input: null }
        ])
      },
      "tickets"
    )

    // Unreachable until someone grants it — which is exactly why it has to be
    // reported rather than left to be noticed.
    expect(second.entries).toEqual([
      {
        kind: "added",
        integration: IntegrationSlug.make("tickets"),
        connection: ConnectionName.make("default"),
        tool: ToolName.make("deleteEverything")
      }
    ])
  })

  test("does not report the same removal on every later refresh", async () => {
    const store = await makeStore()
    await refreshIntegrationSnapshot(
      {
        store,
        executor: executorWithTools([
          { name: "create", input: null },
          { name: "legacy", input: null }
        ])
      },
      "tickets"
    )

    const removal = await refreshIntegrationSnapshot(
      { store, executor: executorWithTools([{ name: "create", input: null }]) },
      "tickets"
    )
    const afterwards = await refreshIntegrationSnapshot(
      { store, executor: executorWithTools([{ name: "create", input: null }]) },
      "tickets"
    )

    expect(removal.entries.map((entry) => entry.kind)).toEqual(["removed"])
    expect(afterwards.entries).toEqual([])
  })
})

describe("gateway maintenance", () => {
  const connection: ConnectionRef = {
    owner: "org",
    integration: IntegrationSlug.make("tickets"),
    name: ConnectionName.make("default")
  }

  test("turns an undecided approval into an expired one", async () => {
    const store = await makeStore()
    const client = await store.createClient({
      id: newClientId(),
      name: "sales",
      mayMutate: false
    })
    const grant = await store.createGrant({
      id: newGrantId(),
      clientId: client.id,
      alias: Alias.make("tickets"),
      tool: ToolName.make("create"),
      connection,
      decision: "require_approval"
    })
    const stale = await store.createApproval({
      id: newApprovalId(),
      clientId: client.id,
      grantId: grant.id,
      alias: grant.alias,
      tool: grant.tool,
      arguments: {},
      expiresAt: new Date(Date.now() - 1_000)
    })
    const fresh = await store.createApproval({
      id: newApprovalId(),
      clientId: client.id,
      grantId: grant.id,
      alias: Alias.make("tickets"),
      tool: ToolName.make("close"),
      arguments: {},
      expiresAt: new Date(Date.now() + 60_000)
    })

    const result = await runMaintenance(store)

    expect(result.expiredApprovals).toBe(1)
    // Expiry is a decision: the invocation does not happen.
    expect((await store.getApproval(stale.id))?.status).toBe("expired")
    expect((await store.getApproval(fresh.id))?.status).toBe("pending")
  })

  test("ages out audit arguments while keeping the record", async () => {
    const store = await makeStore()
    const id = newAuditId()
    await store.recordAudit({
      id,
      clientId: null,
      alias: Alias.make("tickets"),
      tool: ToolName.make("create"),
      connection,
      decision: "allow",
      outcome: "succeeded",
      message: null,
      arguments: { value: { body: "PII" }, expiresAt: new Date(Date.now() - 1_000) }
    })

    const result = await runMaintenance(store)

    expect(result.expiredAuditArguments).toBe(1)
    expect(await store.listAudit({ limit: 10 })).toHaveLength(1)
  })

  test("is safe to run when there is nothing to do", async () => {
    const store = await makeStore()
    expect(await runMaintenance(store)).toEqual({
      expiredApprovals: 0,
      expiredAuditArguments: 0
    })
  })
})
