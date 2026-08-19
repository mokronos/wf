import type { ExecutorServices } from "@mokronos/wfkit-executor"
import { ConnectionName, IntegrationSlug, ToolName } from "./domain.ts"
import type { DriftEntry, ToolSnapshot } from "./domain.ts"
import type { GatewayStore } from "./store.ts"

/** Pure discovery means tool names and shapes belong to vendors. A rename or a
 * reshaped schema is therefore a normal event, not a bug — but it is one that
 * silently breaks grants and workflows if nobody is told.
 *
 * The failure direction is already safe: a grant that no longer matches denies
 * rather than allows. What is missing without this is the *signal*, so a
 * workflow does not die at 3am with "tool not found" and no explanation. */
const schemaFingerprint = (snapshot: Pick<ToolSnapshot, "inputSchema" | "outputSchema">): string =>
  JSON.stringify([snapshot.inputSchema ?? null, snapshot.outputSchema ?? null])

export const diffSnapshots = (
  previous: ReadonlyArray<ToolSnapshot>,
  current: ReadonlyArray<ToolSnapshot>
): ReadonlyArray<DriftEntry> => {
  const key = (snapshot: ToolSnapshot): string =>
    `${snapshot.integration}\u0000${snapshot.connection}\u0000${snapshot.tool}`
  const before = new Map(previous.map((snapshot) => [key(snapshot), snapshot]))
  const after = new Map(current.map((snapshot) => [key(snapshot), snapshot]))
  const entries: Array<DriftEntry> = []

  for (const [identity, snapshot] of after) {
    const existing = before.get(identity)
    if (existing === undefined) {
      // Newly exposed tools are reported too: under explicit grants they are
      // unreachable until someone delegates them, which makes them easy to miss.
      entries.push({
        kind: "added",
        integration: snapshot.integration,
        connection: snapshot.connection,
        tool: snapshot.tool
      })
      continue
    }
    if (schemaFingerprint(existing) !== schemaFingerprint(snapshot)) {
      entries.push({
        kind: "changed",
        integration: snapshot.integration,
        connection: snapshot.connection,
        tool: snapshot.tool
      })
    }
  }

  for (const [identity, snapshot] of before) {
    if (after.has(identity)) continue
    entries.push({
      kind: "removed",
      integration: snapshot.integration,
      connection: snapshot.connection,
      tool: snapshot.tool
    })
  }

  return entries
}

/** The single Executor capability drift detection needs: re-reading what a
 *  vendor exposes right now. Naming the narrow contract here means a stand-in
 *  satisfies it honestly, instead of impersonating the whole Executor surface
 *  and casting the gap away. */
export interface ToolCatalogReader {
  readonly tools: Pick<ExecutorServices["tools"], "list">
}

export type DriftReport = {
  readonly integration: string
  readonly entries: ReadonlyArray<DriftEntry>
  readonly checkedAt: Date
  /** True when there was nothing to compare against — the first sync records
   *  the shape rather than discovering that all of it is new. Reporting fifty
   *  "added" entries for an integration nobody has synced yet is noise that
   *  buries the one real change in the next run. */
  readonly baseline: boolean
  /** How many tools the integration exposes right now. */
  readonly tools: number
}

/** Re-reads an integration's tools, reports what moved since the last sync, and
 *  records the new shape as the baseline. */
export const refreshIntegrationSnapshot = async (
  dependencies: {
    readonly store: GatewayStore
    readonly executor: ToolCatalogReader
  },
  integration: string
): Promise<DriftReport> => {
  const slug = IntegrationSlug.make(integration)
  const checkedAt = new Date()
  const tools = await dependencies.executor.tools.list({ integration })
  const current: ReadonlyArray<ToolSnapshot> = tools.map((tool) => ({
    integration: slug,
    connection: ConnectionName.make(tool.connection),
    tool: ToolName.make(tool.name),
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    syncedAt: checkedAt
  }))
  const previous = await dependencies.store.listToolSnapshots(slug)
  const baseline = previous.length === 0
  const entries = baseline ? [] : diffSnapshots(previous, current)
  await dependencies.store.putToolSnapshots(current)
  // Removed tools keep their old snapshot row, so the next refresh does not
  // report the same removal forever.
  await dependencies.store.forgetToolSnapshots(
    entries.filter((entry) => entry.kind === "removed").map((entry) => ({
      integration: slug,
      connection: entry.connection,
      tool: entry.tool
    }))
  )
  return { integration, entries, checkedAt, baseline, tools: current.length }
}
