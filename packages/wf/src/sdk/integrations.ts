export type IntegrationKind = "mcp" | "openapi" | "graphql" | "cli"

export interface DiscoverIntegrationsOptions {
  readonly kind?: IntegrationKind
  readonly limit?: number
  readonly baseUrl?: string
}

export interface IntegrationSearchResult {
  readonly domain: string
  readonly name: string
  readonly description: string
  readonly kinds: ReadonlyArray<IntegrationKind>
  readonly url: string
}

export interface DiscoverIntegrationsResult {
  readonly results: ReadonlyArray<IntegrationSearchResult>
}

export const discover = async (
  searchTerm: string,
  options: DiscoverIntegrationsOptions = {}
): Promise<DiscoverIntegrationsResult> => {
  const query = searchTerm.trim()

  if (query.length === 0) {
    throw new Error("discover requires a non-empty search term")
  }

  const url = new URL("/api/search", options.baseUrl ?? "https://integrations.sh")
  url.searchParams.set("q", query)

  if (options.kind !== undefined) {
    url.searchParams.set("kind", options.kind)
  }

  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit))
  }

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`integrations.sh discover failed: ${response.status} ${response.statusText}`)
  }

  return await response.json() as DiscoverIntegrationsResult
}
