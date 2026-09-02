import { CircleAlert, History, Layers3, Workflow } from "lucide-react"
import { cn } from "@/lib/utils"

export type AppView = "workflows" | "runs"

const navItems = [
  { id: "workflows", label: "Workflows", icon: Workflow },
  { id: "runs", label: "Runs", icon: History }
] satisfies ReadonlyArray<{ readonly id: AppView; readonly label: string; readonly icon: typeof Workflow }>

export function AppSidebar({
  view,
  totalNodes,
  diagnosticsCount,
  onViewChange
}: {
  readonly view: AppView
  readonly totalNodes: number
  readonly diagnosticsCount: number
  readonly onViewChange: (view: AppView) => void
}) {
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-mark">
          <Workflow aria-hidden="true" />
        </div>
        <div>
          <p className="eyebrow">wf observer</p>
          <h1>Workflow Map</h1>
        </div>
      </div>

      <nav className="side-nav" aria-label="Main views">
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className={cn("side-nav-item", view === item.id && "active")}
              onClick={() => onViewChange(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-status">
        <p>Workspace status</p>
        <span><Layers3 aria-hidden="true" /> {totalNodes} nodes mapped</span>
        <span className={cn(diagnosticsCount > 0 && "has-diagnostics")}>
          <CircleAlert aria-hidden="true" /> {diagnosticsCount} diagnostics
        </span>
      </div>
    </aside>
  )
}
