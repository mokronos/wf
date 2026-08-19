import { whenPresent, whenPresentFields, whenPresentMap } from "@/lib/optional"
import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { ExternalLink, Plug, Search, Unplug } from "lucide-react"
import { toast } from "sonner"

import { JsonView } from "@/components/json-view"
import { LoadingRows, Page, QueryError, ReloadButton } from "@/components/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import * as gateway from "@/lib/gateway"
import { keys, useIntegrations, useInvalidate, useMutation } from "@/lib/queries"
import type { ExecutorConnection, ExecutorTool, IntegrationOverview } from "@/lib/schemas"
import { when } from "@/lib/format"
import { cn } from "@/lib/utils"

const isConnected = (integration: IntegrationOverview): boolean =>
  integration.connections.length > 0

const expiry = (connection: ExecutorConnection): string =>
  connection.expiresAt === undefined || connection.expiresAt === null
    ? "no expiry"
    : `expires ${when(new Date(connection.expiresAt))}`

function ConnectionBadge({ integration }: { readonly integration: IntegrationOverview }) {
  if (isConnected(integration)) return <Badge>connected</Badge>
  return (
    <Badge variant={integration.requiresAuthentication ? "destructive" : "secondary"}>
      {integration.requiresAuthentication ? "needs auth" : "not connected"}
    </Badge>
  )
}

/** Discovery is the only way an integration enters the catalog, and it is a
 *  privileged act — it installs whatever the URL turns out to be. */
function DiscoverDialog() {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("")
  const [connection, setConnection] = useState("default")

  const discover = useMutation({
    mutationFn: () =>
      gateway.discoverIntegration({
        url,
        ...whenPresentMap("connection", connection.trim() || undefined, (name) => name)
      }),
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Installed ${result.integration.name}`, {
        description: `${result.tools.length} tools discovered`
      })
      setOpen(false)
      setUrl("")
    },
    onError: (error: Error) => toast.error("Discovery failed", { description: error.message })
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Discover</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Discover an integration</DialogTitle>
          <DialogDescription>
            Point the gateway at an MCP endpoint or an OpenAPI document. It
            inspects the URL, installs what it finds, and opens a connection.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="discover-url">Endpoint</Label>
            <Input
              id="discover-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/mcp"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="discover-connection">Connection name</Label>
            <Input
              id="discover-connection"
              value={connection}
              onChange={(event) => setConnection(event.target.value)}
              placeholder="default"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => discover.mutate()}
            disabled={url.trim().length === 0 || discover.isPending}
          >
            {discover.isPending ? "Discovering…" : "Discover"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Credential entry. OAuth is deliberately a different path: the gateway drives
 *  the flow and hosts the callback, because it is what holds the credential. */
function ConnectDialog({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("default")
  const [template, setTemplate] = useState(integration.authMethods[0]?.template ?? "")
  const [token, setToken] = useState("")
  const [session, setSession] = useState<string | undefined>()

  const method = integration.authMethods.find((candidate) => candidate.template === template)
  const isOAuth = method?.kind === "oauth"

  const connect = useMutation({
    mutationFn: () =>
      gateway.createConnection({
        integration: integration.slug,
        connection: name,
        ...whenPresent("template", template || undefined),
        ...whenPresentFields(token || undefined, (present) => ({ values: { token: present } }))
      }),
    onSuccess: (result) => {
      invalidate(keys.integrations, keys.connections)
      toast.success(`Connected ${integration.name}`, {
        description: `${result.tools.length} tools available`
      })
      setOpen(false)
      setToken("")
    },
    onError: (error: Error) => toast.error("Could not connect", { description: error.message })
  })

  const startOAuth = useMutation({
    mutationFn: () =>
      gateway.startOAuth({
        integration: integration.slug,
        connection: name,
        ...whenPresent("template", template || undefined)
      }),
    onSuccess: (started) => {
      setSession(started.id)
      if (started.state.status === "pending") {
        window.open(started.state.authorizationUrl, "_blank", "noopener")
        toast.info("Finish the authorization in the tab that opened")
      }
    },
    onError: (error: Error) => toast.error("Could not start OAuth", { description: error.message })
  })

  // The gateway runs the flow and the caller polls; there is nothing to await
  // here, because the browser trip happens outside this page entirely.
  useEffect(() => {
    if (session === undefined) return
    const timer = setInterval(() => {
      void gateway.pollOAuth(session).then((current) => {
        if (current.state.status === "connected") {
          clearInterval(timer)
          setSession(undefined)
          setOpen(false)
          invalidate(keys.integrations, keys.connections)
          toast.success(`Connected ${integration.name}`)
        }
        if (current.state.status === "failed") {
          clearInterval(timer)
          setSession(undefined)
          toast.error("Authorization failed", { description: current.state.message })
        }
      }).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [session, integration.name, integration.slug, invalidate])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Connect</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {integration.name}</DialogTitle>
          <DialogDescription>
            The credential is sealed by the gateway. Nothing that calls through
            it ever receives the credential itself.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="connect-name">Connection name</Label>
            <Input
              id="connect-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="default"
            />
            <p className="text-muted-foreground text-xs">
              Distinguishes several accounts on one integration — work, personal.
            </p>
          </div>
          {integration.authMethods.length === 0 ? null : (
            <div className="space-y-1.5">
              <Label>Auth method</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a method" />
                </SelectTrigger>
                <SelectContent>
                  {integration.authMethods.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.template}>
                      {candidate.label} · {candidate.kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {isOAuth ? null : (
            <div className="space-y-1.5">
              <Label htmlFor="connect-token">Token</Label>
              <Input
                id="connect-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste the API key or token"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          {isOAuth
            ? (
              <Button
                onClick={() => startOAuth.mutate()}
                disabled={startOAuth.isPending || session !== undefined}
              >
                {session === undefined
                  ? startOAuth.isPending ? "Starting…" : "Authorize in browser"
                  : "Waiting for authorization…"}
              </Button>
            )
            : (
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                {connect.isPending ? "Connecting…" : "Connect"}
              </Button>
            )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToolCard({ tool }: { readonly tool: ExecutorTool }) {
  return (
    <details className="group rounded-lg border p-3">
      <summary className="flex cursor-pointer list-none items-center gap-2">
        <span className="font-medium">{tool.name}</span>
        <Badge variant="outline">{tool.connection}</Badge>
        <code className="text-muted-foreground ml-auto truncate font-mono text-xs">
          {tool.address}
        </code>
      </summary>
      <div className="mt-3 space-y-3">
        {tool.description.length === 0
          ? null
          : <p className="text-muted-foreground text-sm">{tool.description}</p>}
        {tool.inputTypeScript === undefined ? null : (
          <pre className="bg-muted/60 overflow-auto rounded-md p-3 font-mono text-xs">
            {tool.inputTypeScript}
          </pre>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <JsonView value={tool.inputSchema ?? null} label="input schema" />
          <JsonView value={tool.outputSchema ?? null} label="output schema" />
        </div>
      </div>
    </details>
  )
}

function IntegrationDetail({ integration }: { readonly integration: IntegrationOverview }) {
  const invalidate = useInvalidate()
  const [filter, setFilter] = useState("")

  const disconnect = useMutation({
    mutationFn: (connection: ExecutorConnection) =>
      gateway.removeConnection({ integration: integration.slug, name: connection.name }),
    onSuccess: () => {
      invalidate(keys.integrations, keys.connections)
      toast.success("Connection removed")
    },
    onError: (error: Error) => toast.error("Could not disconnect", { description: error.message })
  })

  const tools = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return integration.tools
    return integration.tools.filter((tool) =>
      `${tool.name} ${tool.address} ${tool.description}`.toLowerCase().includes(needle)
    )
  }, [filter, integration.tools])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Plug className="size-4" />
          <CardTitle>{integration.name}</CardTitle>
          <ConnectionBadge integration={integration} />
          <div className="ml-auto">
            <ConnectDialog integration={integration} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs uppercase">Slug</dt>
              <dd><code className="font-mono">{integration.slug}</code></dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs uppercase">Kind</dt>
              <dd>{integration.kind}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs uppercase">Auth</dt>
              <dd>
                {integration.authMethods.length === 0
                  ? "none"
                  : integration.authMethods.map((method) => `${method.template}:${method.kind}`)
                    .join(", ")}
              </dd>
            </div>
          </dl>

          {integration.displayUrl === undefined ? null : (
            <a
              className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
              href={integration.displayUrl}
              target="_blank"
              rel="noreferrer"
            >
              {integration.displayUrl}
              <ExternalLink className="size-3" />
            </a>
          )}

          {integration.description.length === 0
            ? null
            : <p className="text-muted-foreground text-sm">{integration.description}</p>}

          <Separator />

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide">Connections</p>
            {integration.connections.length === 0
              ? <p className="text-muted-foreground text-sm">Not connected.</p>
              : (
                <ul className="space-y-2">
                  {integration.connections.map((connection) => (
                    <li
                      key={connection.address}
                      className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <span className="font-medium">{connection.name}</span>
                      <Badge variant="outline">{connection.owner}</Badge>
                      <Badge variant="secondary">{connection.template}</Badge>
                      {connection.identityLabel === undefined || connection.identityLabel === null
                        ? null
                        : <span className="text-muted-foreground">{connection.identityLabel}</span>}
                      <span className="text-muted-foreground text-xs">{expiry(connection)}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => disconnect.mutate(connection)}
                        disabled={disconnect.isPending}
                      >
                        <Unplug className="size-3" />
                        Disconnect
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>Tools</CardTitle>
          <div className="relative w-64">
            <Search className="text-muted-foreground absolute left-2 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              className="pl-7"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter tools"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {integration.toolError === undefined ? null : (
            <p className="text-destructive text-sm">{integration.toolError}</p>
          )}
          {integration.tools.length === 0
            ? (
              <p className="text-muted-foreground text-sm">
                {isConnected(integration)
                  ? "This connection exposes no callable tools."
                  : "Connect it to see what it exposes."}
              </p>
            )
            : tools.length === 0
            ? <p className="text-muted-foreground text-sm">Nothing matches that filter.</p>
            : tools.map((tool) => <ToolCard key={tool.address} tool={tool} />)}
        </CardContent>
      </Card>
    </div>
  )
}

export function IntegrationsRoute() {
  const navigate = useNavigate()
  const { slug } = useParams()
  const integrations = useIntegrations()
  const [filter, setFilter] = useState("")

  const all = integrations.data ?? []
  const selected = all.find((integration) => integration.slug === slug) ?? all[0]

  const listed = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle.length === 0) return all
    return all.filter((integration) =>
      `${integration.name} ${integration.slug}`.toLowerCase().includes(needle)
    )
  }, [all, filter])

  return (
    <Page
      title="Integrations"
      description="What this gateway knows how to reach, and which of it is connected."
      actions={
        <>
          <DiscoverDialog />
          <ReloadButton
            onClick={() => void integrations.refetch()}
            busy={integrations.isFetching}
          />
        </>
      }
    >
      <QueryError error={integrations.error} />

      {integrations.isPending
        ? <LoadingRows />
        : all.length === 0
        ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              No integrations yet. Discover one to get started.
            </CardContent>
          </Card>
        )
        : (
          <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
            <Card className="h-fit">
              <CardHeader>
                <Input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter integrations"
                />
              </CardHeader>
              <CardContent className="space-y-1">
                {listed.map((integration) => (
                  <button
                    key={integration.slug}
                    type="button"
                    onClick={() => void navigate(`/integrations/${integration.slug}`)}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-md border p-2 text-left text-sm transition-colors",
                      selected?.slug === integration.slug
                        ? "border-primary bg-accent/40"
                        : "hover:bg-accent/20"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{integration.name}</span>
                      <ConnectionBadge integration={integration} />
                    </span>
                    <span className="text-muted-foreground flex items-center gap-2 font-mono text-xs">
                      {integration.slug}
                      <span>· {integration.tools.length} tools</span>
                    </span>
                  </button>
                ))}
              </CardContent>
            </Card>

            {selected === undefined
              ? null
              : <IntegrationDetail integration={selected} />}
          </div>
        )}
    </Page>
  )
}
