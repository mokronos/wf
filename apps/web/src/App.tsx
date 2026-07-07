import { useCallback, useEffect, useMemo, useState } from "react"

import { AppSidebar, type AppView } from "@/components/app-sidebar"
import { RunsView } from "@/components/runs-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkflowsView } from "@/components/workflows-view"
import { useApi } from "@/hooks/use-api"
import { fetchRuns, fetchWorkflows, workflowKey } from "@/lib/api"
import { cn } from "@/lib/utils"

const SIDEBAR_STORAGE_KEY = "wf.sidebarCollapsed"

export default function App() {
  const workflowsState = useApi(fetchWorkflows)
  const runsState = useApi(fetchRuns)
  const [view, setView] = useState<AppView>("workflows")
  const [query, setQuery] = useState("")
  const [selectedWorkflowKey, setSelectedWorkflowKey] = useState<string | undefined>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") {
      return false
    }
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true"
  })

  const workflows = workflowsState.data?.workflows ?? []
  const filteredWorkflows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) {
      return workflows
    }
    return workflows.filter((item) =>
      `${item.artifact.id} ${item.artifact.name} ${item.artifact.version} ${item.exportName ?? ""}`
        .toLowerCase()
        .includes(needle)
    )
  }, [query, workflows])

  const totalNodes = workflows.reduce((sum, item) => sum + (item.graph?.nodes.length ?? 0), 0)
  const diagnosticsCount = workflows.filter((item) => item.graph === undefined || item.diagnostics.length > 0).length

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    if (
      selectedWorkflowKey !== undefined &&
      filteredWorkflows.some((item) => workflowKey(item) === selectedWorkflowKey)
    ) {
      return
    }
    setSelectedWorkflowKey(filteredWorkflows[0] === undefined ? undefined : workflowKey(filteredWorkflows[0]))
  }, [filteredWorkflows, selectedWorkflowKey])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => !value)
  }, [])

  return (
    <TooltipProvider>
      <main className={cn("app-shell", sidebarCollapsed && "sidebar-collapsed")}>
        <AppSidebar
          collapsed={sidebarCollapsed}
          view={view}
          workflows={workflows}
          filtered={filteredWorkflows}
          loading={workflowsState.loading}
          query={query}
          selectedKey={selectedWorkflowKey}
          totalNodes={totalNodes}
          diagnosticsCount={diagnosticsCount}
          onToggleCollapsed={toggleSidebar}
          onViewChange={setView}
          onQueryChange={setQuery}
          onWorkflowSelect={(key) => {
            setSelectedWorkflowKey(key)
            setView("workflows")
          }}
        />
        {view === "workflows" ? (
          <WorkflowsView
            workflows={workflows}
            filtered={filteredWorkflows}
            loading={workflowsState.loading}
            error={workflowsState.error}
            generatedAt={workflowsState.data?.generatedAt}
            selectedKey={selectedWorkflowKey}
            onSelectedKeyChange={setSelectedWorkflowKey}
            onReload={workflowsState.reload}
          />
        ) : (
          <RunsView
            runs={runsState.data?.runs ?? []}
            loading={runsState.loading}
            error={runsState.error}
            generatedAt={runsState.data?.generatedAt}
            onReload={runsState.reload}
          />
        )}
      </main>
    </TooltipProvider>
  )
}
