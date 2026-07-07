import { useMemo } from "react"
import * as dagre from "dagre"
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from "reactflow"
import "reactflow/dist/style.css"
import { Activity, FileCode2, GitBranch, Info } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import type { WorkflowGraph, WorkflowGraphNode } from "@/lib/api"
import { compactDate } from "@/lib/format"
import { nodeTypes, type FlowNodeData } from "./workflow-node"

const NODE_WIDTH = 250
const NODE_HEIGHT = 86

const layoutNodes = (
  graph: WorkflowGraph | undefined,
  selectedNodeId: string | undefined,
  onInspect: (node: WorkflowGraphNode) => void
): Node<FlowNodeData>[] => {
  if (graph === undefined) {
    return []
  }

  const layout = new dagre.graphlib.Graph()
  layout.setDefaultEdgeLabel(() => ({}))
  layout.setGraph({ rankdir: "LR", nodesep: 46, ranksep: 96, marginx: 36, marginy: 64 })

  for (const node of graph.nodes) {
    layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of graph.edges) {
    layout.setEdge(edge.source, edge.target)
  }
  dagre.layout(layout)

  return graph.nodes.map((node) => {
    const point = layout.node(node.id) as { readonly x: number; readonly y: number } | undefined
    return {
      id: node.id,
      type: "workflowNode",
      position: {
        x: (point?.x ?? 0) - NODE_WIDTH / 2,
        y: (point?.y ?? 0) - NODE_HEIGHT / 2
      },
      data: {
        graphNode: node,
        selected: node.id === selectedNodeId,
        onInspect
      },
      draggable: true
    }
  })
}

const layoutEdges = (graph: WorkflowGraph | undefined): Edge[] =>
  graph?.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    animated: edge.label === "repeat",
    type: "smoothstep",
    className: "flow-edge"
  })) ?? []

export function WorkflowCanvas({
  graph,
  diagnostics,
  generatedAt,
  loading,
  selectedNodeId,
  onInspect,
  onDeselect
}: {
  readonly graph: WorkflowGraph | undefined
  readonly diagnostics: ReadonlyArray<string>
  readonly generatedAt: string | undefined
  readonly loading: boolean
  readonly selectedNodeId: string | undefined
  readonly onInspect: (node: WorkflowGraphNode) => void
  readonly onDeselect: () => void
}) {
  const flowNodes = useMemo(
    () => layoutNodes(graph, selectedNodeId, onInspect),
    [graph, selectedNodeId, onInspect]
  )
  const flowEdges = useMemo(() => layoutEdges(graph), [graph])

  return (
    <div className="canvas-shell">
      <div className="canvas-toolbar">
        <Badge variant="secondary">
          <Activity aria-hidden="true" />
          {graph?.nodes.length ?? 0} nodes
        </Badge>
        <Badge variant="secondary">
          <GitBranch aria-hidden="true" />
          {graph?.edges.length ?? 0} edges
        </Badge>
        <Badge variant={diagnostics.length > 0 ? "destructive" : "secondary"}>
          <Info aria-hidden="true" />
          {diagnostics.length} diagnostics
        </Badge>
        <span className="updated-at">
          {generatedAt === undefined ? "" : `updated ${compactDate(generatedAt)}`}
        </span>
      </div>

      {loading ? (
        <div className="canvas-loading">
          <Skeleton className="h-16 w-56" />
          <Skeleton className="h-16 w-56" />
          <Skeleton className="h-16 w-56" />
        </div>
      ) : graph === undefined ? (
        <div className="empty-canvas">
          <FileCode2 aria-hidden="true" />
          <h3>No graph available</h3>
          <p>The selected workflow could not be loaded or the workflow store is empty.</p>
        </div>
      ) : (
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.25}
          maxZoom={1.6}
          onPaneClick={onDeselect}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(255,255,255,0.18)" gap={28} />
          <MiniMap nodeStrokeWidth={3} pannable zoomable />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  )
}
