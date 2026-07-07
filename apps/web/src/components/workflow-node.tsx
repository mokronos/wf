import {
  AlertTriangle,
  Braces,
  CircleDot,
  Clock3,
  GitFork,
  Play,
  Radio,
  Shuffle,
  Square,
  TimerReset
} from "lucide-react"
import { Handle, Position, type NodeProps } from "reactflow"

import type { WorkflowGraphNode, WorkflowGraphNodeKind } from "@/lib/api"
import { cn } from "@/lib/utils"

export interface FlowNodeData {
  readonly graphNode: WorkflowGraphNode
  readonly selected: boolean
  readonly onInspect: (node: WorkflowGraphNode) => void
}

export const kindIcon = {
  start: Play,
  end: Square,
  step: CircleDot,
  sleep: Clock3,
  signal: Radio,
  now: TimerReset,
  random: Shuffle,
  code: Braces,
  all: GitFork,
  error: AlertTriangle
} satisfies Record<WorkflowGraphNodeKind, typeof CircleDot>

export const kindClass = {
  start: "node-start",
  end: "node-end",
  step: "node-step",
  sleep: "node-sleep",
  signal: "node-signal",
  now: "node-now",
  random: "node-random",
  code: "node-code",
  all: "node-all",
  error: "node-error"
} satisfies Record<WorkflowGraphNodeKind, string>

export const nodeTypes = {
  workflowNode: ({ data }: NodeProps<FlowNodeData>) => {
    const Icon = kindIcon[data.graphNode.kind]
    const reason = typeof data.graphNode.metadata.reason === "string"
      ? data.graphNode.metadata.reason
      : data.graphNode.description

    return (
      <button
        type="button"
        onClick={() => data.onInspect(data.graphNode)}
        className={cn("flow-node", kindClass[data.graphNode.kind], data.selected && "is-selected")}
      >
        <Handle type="target" position={Position.Left} className="flow-handle" />
        <span className="flow-node-icon">
          <Icon aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flow-node-label">{data.graphNode.label}</span>
          {data.graphNode.kind === "code" && reason !== undefined ? (
            <span className="flow-node-reason" title={reason}>{reason}</span>
          ) : null}
          <span className="flow-node-meta">
            {data.graphNode.kind}
            {data.graphNode.invocation === undefined ? "" : ` #${data.graphNode.invocation}`}
            {data.graphNode.repeated ? " repeat" : ""}
          </span>
        </span>
        <Handle type="source" position={Position.Right} className="flow-handle" />
      </button>
    )
  }
}
