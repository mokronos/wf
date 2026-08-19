import { whenPresent } from "@mokronos/wfkit"
import { listExecutorIntegrations } from "./catalog.ts"
import type { ExecutorCatalog } from "./catalog.ts"
import { listExecutorConnections } from "./connections.ts"
import type { ExecutorConnections } from "./connections.ts"
import type { ExecutorTool, IntegrationOverview } from "./schemas.ts"
import { listExecutorTools } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationOverviewDependencies {
  readonly catalog: Pick<ExecutorCatalog, "list">
  readonly connections: Pick<ExecutorConnections, "list">
  readonly tools: Pick<ExecutorTools, "list">
}

const toolsForConnection = async (
  integration: string,
  connection: string,
  tools: Pick<ExecutorTools, "list">
): Promise<{ readonly tools: ReadonlyArray<ExecutorTool>; readonly error?: string }> => {
  try {
    return { tools: await tools.list({ integration, connection }) }
  } catch (cause) {
    return {
      tools: [],
      error: `${connection}: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
}

/** The full picture of what is connected: every catalog integration with its
 * connections and the tools each connection exposes. Listing tools reaches the
 * live endpoint, so a failing integration reports `toolError` instead of
 * failing the whole overview. */
export const createIntegrationOverview = (
  dependencies: IntegrationOverviewDependencies
) => async (): Promise<ReadonlyArray<IntegrationOverview>> => {
  const [integrations, connections] = await Promise.all([
    dependencies.catalog.list(),
    dependencies.connections.list()
  ])
  const overviews = await Promise.all(integrations.map(async (integration) => {
    const owned = connections.filter((connection) => connection.integration === integration.slug)
    const listings = await Promise.all(owned.map((connection) =>
      toolsForConnection(integration.slug, connection.name, dependencies.tools)
    ))
    const errors = listings.flatMap((listing) => listing.error === undefined ? [] : [listing.error])
    const tools = listings
      .flatMap((listing) => listing.tools)
      .toSorted((left, right) => left.name.localeCompare(right.name))
    return {
      slug: integration.slug,
      name: integration.name,
      description: integration.description,
      kind: integration.kind,
      ...whenPresent("displayUrl", integration.displayUrl),
      requiresAuthentication: integration.authMethods.length > 0 &&
        !integration.authMethods.some((method) => method.kind === "none"),
      authMethods: integration.authMethods,
      connections: owned,
      tools,
      ...whenPresent("toolError", errors.length === 0 ? undefined : errors.join("; "))
    }
  }))
  return overviews.toSorted((left, right) => left.name.localeCompare(right.name))
}

export const listIntegrationOverviews = createIntegrationOverview({
  catalog: { list: listExecutorIntegrations },
  connections: { list: listExecutorConnections },
  tools: { list: listExecutorTools }
})
