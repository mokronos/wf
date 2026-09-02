import { useEffect, useMemo, useState } from "react"

import { AppSidebar, type AppView } from "@/components/app-sidebar"
import { RunsView } from "@/components/runs-view"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkflowsView } from "@/components/workflows-view"
import { useApi } from "@/hooks/use-api"
import { fetchRuns, fetchWorkflows, workflowKey } from "@/lib/api"

export default function App() {
  const workflowsState = useApi(fetchWorkflows)
  const runsState = useApi(fetchRuns)
  const [view, setView] = useState<AppView>("workflows")
  const [selectedWorkflowKey, setSelectedWorkflowKey] = useState<string | undefined>()

  const workflows = workflowsState.data?.workflows ?? []
  const filteredWorkflows = useMemo(() => workflows, [workflows])

  const totalNodes = workflows.reduce((sum, item) => sum + (item.graph?.nodes.length ?? 0), 0)
  const diagnosticsCount = workflows.filter((item) => item.graph === undefined || item.diagnostics.length > 0).length

  useEffect(() => {
    if (
      selectedWorkflowKey !== undefined &&
      filteredWorkflows.some((item) => workflowKey(item) === selectedWorkflowKey)
    ) {
      return
    }
    setSelectedWorkflowKey(filteredWorkflows[0] === undefined ? undefined : workflowKey(filteredWorkflows[0]))
  }, [filteredWorkflows, selectedWorkflowKey])

  return (
    <TooltipProvider>
      <main className="app-shell">
        <AppSidebar
          view={view}
          totalNodes={totalNodes}
          diagnosticsCount={diagnosticsCount}
          onViewChange={setView}
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
