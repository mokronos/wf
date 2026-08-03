import { useMemo, useState } from "react"
import { AlertTriangle, ExternalLink, Plug, RefreshCw, Search, Unplug } from "lucide-react"

import { SchemaView } from "@/components/schema-view"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ExecutorConnection, ExecutorTool, IntegrationOverview } from "@/lib/api"
import { compactDate } from "@/lib/format"
import { cn } from "@/lib/utils"

const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.length > 0

const connectionExpiry = (connection: ExecutorConnection): string =>
  connection.expiresAt === undefined || connection.expiresAt === null
    ? "no expiry"
    : `expires ${compactDate(new Date(connection.expiresAt * 1000).toISOString())}`

const toolLabel = (count: number): string => count === 1 ? "1 tool" : `${count} tools`

const authSummary = (integration: IntegrationOverview): string =>
  integration.authMethods.length === 0
    ? "no auth"
    : integration.authMethods.map((method) => `${method.template}:${method.kind}`).join(", ")

export function IntegrationsView({
  integrations,
  loading,
  error,
  generatedAt,
  onReload
}: {
  readonly integrations: ReadonlyArray<IntegrationOverview>
  readonly loading: boolean
  readonly error: string | undefined
  readonly generatedAt: string | undefined
  readonly onReload: () => Promise<void>
}) {
  const [selectedSlug, setSelectedSlug] = useState<string | undefined>()
  const [toolQuery, setToolQuery] = useState("")

  const selected = integrations.find((integration) => integration.slug === selectedSlug) ??
    integrations[0]
  const connectedCount = integrations.filter(isConnected).length
  const toolCount = integrations.reduce((sum, integration) => sum + integration.tools.length, 0)

  const tools = useMemo(() => {
    const needle = toolQuery.trim().toLowerCase()
    const available = selected?.tools ?? []
    if (needle.length === 0) {
      return available
    }
    return available.filter((tool) =>
      `${tool.name} ${tool.address} ${tool.description}`.toLowerCase().includes(needle)
    )
  }, [selected, toolQuery])

  return (
    <section className="workbench integrations-workbench">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">connected services</p>
          <h2>Integrations</h2>
        </div>
        <div className="topbar-actions">
          <Badge variant="secondary">{connectedCount} connected</Badge>
          <Badge variant="secondary">{toolLabel(toolCount)}</Badge>
          <span className="updated-at light">
            {generatedAt === undefined ? "" : `updated ${compactDate(generatedAt)}`}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={() => void onReload()} disabled={loading}>
                <RefreshCw className={cn(loading && "animate-spin")} aria-hidden="true" />
                <span className="sr-only">Refresh integrations</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh integrations</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Could not load integrations</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="integrations-layout">
        <Card className="integrations-list-card">
          <CardHeader>
            <CardTitle>Catalog</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="stack">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : integrations.length === 0 ? (
              <div className="empty-panel light-panel">
                <Unplug aria-hidden="true" />
                <p>No integrations yet.</p>
                <span>Register one with <code>wf i discover &lt;url&gt;</code>.</span>
              </div>
            ) : (
              <div className="integration-table" role="list">
                {integrations.map((integration) => (
                  <button
                    key={integration.slug}
                    type="button"
                    role="listitem"
                    onClick={() => {
                      setSelectedSlug(integration.slug)
                      setToolQuery("")
                    }}
                    className={cn(
                      "integration-row",
                      selected?.slug === integration.slug && "active"
                    )}
                  >
                    <span className="integration-main">
                      <strong>{integration.name}</strong>
                      <code>{integration.slug}</code>
                    </span>
                    <span className="integration-row-meta">
                      <Badge variant="outline">{integration.kind}</Badge>
                      <ConnectionBadge integration={integration} />
                      <span>{toolLabel(integration.tools.length)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="integration-detail">
          <IntegrationSummary integration={selected} />
          <Card className="integration-tools-card">
            <CardHeader>
              <CardTitle>Tools</CardTitle>
              <div className="search-row integration-tool-search">
                <Search aria-hidden="true" />
                <Input
                  value={toolQuery}
                  onChange={(event) => setToolQuery(event.target.value)}
                  placeholder="Filter tools"
                  aria-label="Filter tools"
                  disabled={selected === undefined}
                />
              </div>
            </CardHeader>
            <CardContent>
              <ToolList integration={selected} tools={tools} />
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  )
}

function ConnectionBadge({ integration }: { readonly integration: IntegrationOverview }) {
  if (isConnected(integration)) {
    return <Badge className="integration-connected">connected</Badge>
  }
  return (
    <Badge variant={integration.requiresAuthentication ? "destructive" : "secondary"}>
      {integration.requiresAuthentication ? "needs auth" : "not connected"}
    </Badge>
  )
}

function IntegrationSummary({ integration }: { readonly integration: IntegrationOverview | undefined }) {
  if (integration === undefined) {
    return (
      <Card>
        <CardContent className="run-summary-empty">
          Select an integration to inspect its connections and tools.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <Plug aria-hidden="true" className="integration-title-icon" />
          {integration.name} <ConnectionBadge integration={integration} />
        </CardTitle>
      </CardHeader>
      <CardContent className="integration-summary-grid">
        <div>
          <span>Slug</span>
          <code>{integration.slug}</code>
        </div>
        <div>
          <span>Kind</span>
          <strong>{integration.kind}</strong>
        </div>
        <div>
          <span>Auth</span>
          <strong>{authSummary(integration)}</strong>
        </div>
        {integration.displayUrl === undefined ? null : (
          <div className="integration-summary-wide">
            <span>Endpoint</span>
            <a href={integration.displayUrl} target="_blank" rel="noreferrer">
              {integration.displayUrl}
              <ExternalLink aria-hidden="true" />
            </a>
          </div>
        )}
        {integration.description.length === 0 ? null : (
          <div className="integration-summary-wide">
            <span>Description</span>
            <p>{integration.description}</p>
          </div>
        )}
        <div className="integration-summary-wide">
          <span>Connections</span>
          {integration.connections.length === 0 ? (
            <p className="muted-copy">
              Not connected. Authorize it with <code>wf i connect {integration.slug}</code>.
            </p>
          ) : (
            <ul className="connection-list">
              {integration.connections.map((connection) => (
                <li key={connection.address}>
                  <strong>{connection.name}</strong>
                  <Badge variant="outline">{connection.owner}</Badge>
                  <Badge variant="secondary">{connection.template}</Badge>
                  {connection.identityLabel === undefined || connection.identityLabel === null
                    ? null
                    : <span>{connection.identityLabel}</span>}
                  <span>{connectionExpiry(connection)}</span>
                  <code>{connection.address}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        {integration.toolError === undefined ? null : (
          <Alert variant="destructive" className="integration-summary-wide">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Some tools could not be listed</AlertTitle>
            <AlertDescription>{integration.toolError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
}

function ToolList({
  integration,
  tools
}: {
  readonly integration: IntegrationOverview | undefined
  readonly tools: ReadonlyArray<ExecutorTool>
}) {
  if (integration === undefined) {
    return <p className="muted-copy">No integration selected.</p>
  }
  if (integration.tools.length === 0) {
    return (
      <div className="empty-panel light-panel">
        <Unplug aria-hidden="true" />
        <p>No tools available.</p>
        <span>
          {isConnected(integration)
            ? "This connection exposes no callable tools."
            : `Connect it first: wf i connect ${integration.slug}`}
        </span>
      </div>
    )
  }
  if (tools.length === 0) {
    return <p className="muted-copy">No tools match the filter.</p>
  }

  return (
    <div className="tool-list">
      {tools.map((tool) => <ToolCard key={tool.address} tool={tool} />)}
    </div>
  )
}

function ToolCard({ tool }: { readonly tool: ExecutorTool }) {
  return (
    <details className="tool-card">
      <summary>
        <span className="tool-head">
          <strong>{tool.name}</strong>
          <Badge variant="outline">{tool.connection}</Badge>
        </span>
        <code className="tool-address">{tool.address}</code>
      </summary>
      {tool.description.length === 0 ? null : <p className="tool-description">{tool.description}</p>}
      <div className="tool-schema-grid">
        <ToolSchema
          label="Input"
          schema={tool.inputSchema}
          signature={tool.inputTypeScript}
        />
        <ToolSchema
          label="Output"
          schema={tool.outputSchema}
          signature={tool.outputTypeScript}
        />
      </div>
    </details>
  )
}

function ToolSchema({
  label,
  schema,
  signature
}: {
  readonly label: string
  readonly schema: ExecutorTool["inputSchema"]
  readonly signature: string | undefined
}) {
  return (
    <section className="tool-schema">
      <h4>{label}</h4>
      {signature === undefined ? null : <pre className="tool-signature">{signature}</pre>}
      {schema === undefined
        ? <p className="muted-copy">No {label.toLowerCase()} schema published.</p>
        : <SchemaView schema={schema} />}
    </section>
  )
}
