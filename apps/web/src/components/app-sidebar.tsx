import { ChevronLeft, ChevronRight, History, Layers3, Search, Workflow } from "lucide-react"
import type { ReactElement } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkflowArtifactGraph } from "@/lib/api"
import { workflowKey } from "@/lib/api"
import { cn } from "@/lib/utils"

export type AppView = "workflows" | "runs"

const navItems = [
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "runs", label: "Runs", icon: History }
] satisfies ReadonlyArray<{ readonly id: AppView; readonly label: string; readonly icon: typeof Workflow }>

const SidebarButton = ({
  collapsed,
  label,
  children
}: {
  readonly collapsed: boolean
  readonly label: string
  readonly children: ReactElement
}) => collapsed ? (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
) : children

export function AppSidebar({
  collapsed,
  view,
  workflows,
  filtered,
  loading,
  query,
  selectedKey,
  totalNodes,
  diagnosticsCount,
  onToggleCollapsed,
  onViewChange,
  onQueryChange,
  onWorkflowSelect
}: {
  readonly collapsed: boolean
  readonly view: AppView
  readonly workflows: ReadonlyArray<WorkflowArtifactGraph>
  readonly filtered: ReadonlyArray<WorkflowArtifactGraph>
  readonly loading: boolean
  readonly query: string
  readonly selectedKey: string | undefined
  readonly totalNodes: number
  readonly diagnosticsCount: number
  readonly onToggleCollapsed: () => void
  readonly onViewChange: (view: AppView) => void
  readonly onQueryChange: (query: string) => void
  readonly onWorkflowSelect: (key: string) => void
}) {
  return (
    <aside className={cn("sidebar", collapsed && "is-collapsed")}>
      <div className="brand-block">
        <div className="brand-mark">
          <Workflow aria-hidden="true" />
        </div>
        <div className="sidebar-expanded">
          <p className="eyebrow">wf observer</p>
          <h1>Workflow Map</h1>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="sidebar-toggle"
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
              <span className="sr-only">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
        </Tooltip>
      </div>

      <nav className="side-nav" aria-label="Main views">
        {navItems.map((item) => {
          const Icon = item.icon
          const button = (
            <button
              key={item.id}
              type="button"
              className={cn("side-nav-item", view === item.id && "active")}
              onClick={() => onViewChange(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              <span className="sidebar-expanded">{item.label}</span>
            </button>
          )
          return (
            <SidebarButton key={item.id} collapsed={collapsed} label={item.label}>
              {button}
            </SidebarButton>
          )
        })}
      </nav>

      <div className="sidebar-expanded sidebar-workflows">
        <div className="search-row">
          <Search aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Filter workflows"
            aria-label="Filter workflows"
          />
        </div>

        <div className="metric-grid">
          <Card>
            <CardHeader>
              <CardTitle>Workflows</CardTitle>
            </CardHeader>
            <CardContent>{workflows.length}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Nodes</CardTitle>
            </CardHeader>
            <CardContent>{totalNodes}</CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Diagnostics</CardTitle>
            </CardHeader>
            <CardContent>{diagnosticsCount}</CardContent>
          </Card>
        </div>

        <Separator />

        <ScrollArea className="workflow-list">
          {loading ? (
            <div className="stack">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-panel">
              <Layers3 aria-hidden="true" />
              <p>No workflows found.</p>
              <span>The workflow store is empty.</span>
            </div>
          ) : (
            <div className="stack">
              {filtered.map((item) => {
                const key = workflowKey(item)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onWorkflowSelect(key)}
                    className={cn("workflow-list-item", selectedKey === key && "active")}
                  >
                    <span className="list-item-top">
                      <span>{item.artifact.name}</span>
                      <Badge variant={item.graph === undefined ? "destructive" : "secondary"}>
                        v{item.artifact.version}
                      </Badge>
                    </span>
                    <span className="list-item-sub">
                      {item.artifact.id}
                      {item.exportName === undefined ? "" : ` #${item.exportName}`}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>
    </aside>
  )
}
