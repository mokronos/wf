import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, PanelRight, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { NodeInspector } from "@/components/node-inspector"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MetadataList } from "@/components/metadata-list"
import { SchemaView } from "@/components/schema-view"
import { WorkflowCanvas } from "@/components/workflow-canvas"
import { kindClass, kindIcon } from "@/components/workflow-node"
import type { WorkflowArtifactGraph, WorkflowGraphNode } from "@/lib/api"
import { workflowKey } from "@/lib/api"
import { compactDate, shortId } from "@/lib/format"
import { cn } from "@/lib/utils"

export function WorkflowsView({
  workflows,
  filtered,
  loading,
  error,
  generatedAt,
  selectedKey,
  onSelectedKeyChange,
  onReload
}: {
  readonly workflows: ReadonlyArray<WorkflowArtifactGraph>
  readonly filtered: ReadonlyArray<WorkflowArtifactGraph>
  readonly loading: boolean
  readonly error: string | undefined
  readonly generatedAt: string | undefined
  readonly selectedKey: string | undefined
  readonly onSelectedKeyChange: (key: string | undefined) => void
  readonly onReload: () => Promise<void>
}) {
  const [selectedNode, setSelectedNode] = useState<WorkflowGraphNode | undefined>()
  const selected = useMemo(
    () => filtered.find((item) => workflowKey(item) === selectedKey) ?? filtered[0],
    [filtered, selectedKey]
  )
  const activeKey = selected === undefined ? undefined : workflowKey(selected)
  const graphDiagnostics = [
    ...(selected?.diagnostics ?? []),
    ...(selected?.graph?.diagnostics ?? [])
  ]

  useEffect(() => {
    if (activeKey !== selectedKey) {
      onSelectedKeyChange(activeKey)
    }
  }, [activeKey, onSelectedKeyChange, selectedKey])

  useEffect(() => {
    setSelectedNode(undefined)
  }, [activeKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedNode(undefined)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const onInspect = useCallback((node: WorkflowGraphNode) => {
    setSelectedNode(node)
  }, [])

  return (
    <section className="workbench">
      <header className="topbar">
        <div className="topbar-copy">
          <p className="eyebrow">read-only trace</p>
          <h2>{selected?.artifact.name ?? "No workflow selected"}</h2>
        </div>
        <div className="topbar-actions">
          <Select
            value={activeKey ?? ""}
            onValueChange={(value) => onSelectedKeyChange(value)}
            disabled={filtered.length === 0}
          >
            <SelectTrigger className="w-[240px]">
              <SelectValue placeholder="Select workflow" />
            </SelectTrigger>
            <SelectContent>
              {filtered.map((item) => {
                const key = workflowKey(item)
                return (
                  <SelectItem key={key} value={key}>
                    {item.artifact.name} v{item.artifact.version}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" onClick={() => void onReload()} disabled={loading}>
                <RefreshCw className={cn(loading && "animate-spin")} aria-hidden="true" />
                <span className="sr-only">Refresh workflows</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh workflows</TooltipContent>
          </Tooltip>
          <WorkflowDetails selected={selected} />
        </div>
      </header>

      {error !== undefined ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Could not load workflows</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className={cn("graph-workspace", selectedNode !== undefined && "inspector-open")}>
        <WorkflowCanvas
          graph={selected?.graph}
          diagnostics={graphDiagnostics}
          generatedAt={generatedAt}
          loading={loading}
          selectedNodeId={selectedNode?.id}
          onInspect={onInspect}
          onDeselect={() => setSelectedNode(undefined)}
        />
        {selectedNode === undefined ? null : (
          <NodeInspector node={selectedNode} onClose={() => setSelectedNode(undefined)} />
        )}
      </div>

      <div className="bottom-panels">
        <Card>
          <CardHeader>
            <CardTitle>Trace Notes</CardTitle>
          </CardHeader>
          <CardContent>
            {graphDiagnostics.length === 0 ? (
              <p className="muted-copy">The parser traced this workflow without diagnostics.</p>
            ) : (
              <ul className="diagnostics-list">
                {graphDiagnostics.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Legend</CardTitle>
          </CardHeader>
          <CardContent className="legend-grid">
            {(["step", "sleep", "signal", "code", "all", "now", "random"] as const).map((kind) => {
              const Icon = kindIcon[kind]
              return (
                <span key={kind} className={cn("legend-item", kindClass[kind])}>
                  <Icon aria-hidden="true" />
                  {kind}
                </span>
              )
            })}
          </CardContent>
        </Card>
      </div>
      <span className="sr-only">{workflows.length} workflows loaded</span>
    </section>
  )
}

function WorkflowDetails({
  selected
}: {
  readonly selected: WorkflowArtifactGraph | undefined
}) {
  return (
    <Sheet>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" disabled={selected === undefined}>
              <PanelRight aria-hidden="true" />
              <span className="sr-only">Open workflow details</span>
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>Details</TooltipContent>
      </Tooltip>
      <SheetContent className="details-sheet">
        <SheetHeader>
          <SheetTitle>{selected?.artifact.name ?? "Workflow details"}</SheetTitle>
        </SheetHeader>
        <Tabs defaultValue="workflow">
          <TabsList>
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
            <TabsTrigger value="source">Source</TabsTrigger>
          </TabsList>
          <TabsContent value="workflow" className="tab-panel">
            {selected === undefined ? null : (
              <div className="stack">
                <MetadataList
                  value={{
                    name: selected.artifact.name,
                    version: selected.artifact.version,
                    engineName: selected.graph?.engineName,
                    sourceHash: selected.graph?.sourceHash === undefined
                      ? undefined
                      : shortId(selected.graph.sourceHash),
                    createdAt: compactDate(selected.artifact.createdAt),
                    exportName: selected.exportName,
                    nodeCount: selected.graph?.nodes.length ?? 0,
                    edgeCount: selected.graph?.edges.length ?? 0
                  }}
                />
                {selected.graph?.sourceHash === undefined ? null : (
                  <span className="hash-title" title={selected.graph.sourceHash}>
                    full source hash available on hover
                  </span>
                )}
                <WorkflowSchemaDetails selected={selected} />
              </div>
            )}
          </TabsContent>
          <TabsContent value="source" className="tab-panel">
            <pre className="source-view">{selected?.artifact.source ?? ""}</pre>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}

function WorkflowSchemaDetails({ selected }: { readonly selected: WorkflowArtifactGraph }) {
  const schemas = selected.graph?.schemas
  const entries = ([
    ["input", "Input"],
    ["output", "Output"],
    ["errors", "Errors"]
  ] as const)
    .map(([key, label]) => [key, label, schemas?.[key]] as const)
    .filter(([, , schema]) => schema !== undefined)

  if (entries.length === 0) {
    return <p className="muted-copy">No workflow schemas were captured.</p>
  }

  return (
    <div className="inspector-section-grid">
      {entries.map(([key, label, schema]) => (
        <details key={key} className="schema-panel" open={key !== "errors"}>
          <summary>{label} schema</summary>
          <SchemaView schema={schema} />
        </details>
      ))}
    </div>
  )
}
