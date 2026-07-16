import { X } from "lucide-react"

import { MetadataList } from "@/components/metadata-list"
import { SchemaView } from "@/components/schema-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { WorkflowGraphNode, WorkflowGraphNodeMetadata, WorkflowGraphNodeSchemas } from "@/lib/api"
import { prettyJson } from "@/lib/format"
import { kindClass } from "./workflow-node"

const schemaLabels = [
  ["input", "Input"],
  ["output", "Output"],
  ["errors", "Errors"],
  ["signal", "Signal"]
] as const

const rawMetadata = (node: WorkflowGraphNode): WorkflowGraphNodeMetadata => {
  const {
    input: _input,
    retry: _retry,
    concurrency: _concurrency,
    compensates: _compensates,
    reason: _reason,
    ...rest
  } = node.metadata
  return rest
}

function SchemaSection({ schemas }: { readonly schemas: WorkflowGraphNodeSchemas | undefined }) {
  const entries = schemaLabels
    .map(([key, label]) => [key, label, schemas?.[key]] as const)
    .filter(([, , schema]) => schema !== undefined)

  if (entries.length === 0) {
    return <p className="muted-copy">No schemas were captured for this node.</p>
  }

  return (
    <div className="inspector-section-grid">
      {entries.map(([key, label, schema]) => {
        const open = key === "input" || key === "output"
        return (
          <details key={key} className="schema-panel" open={open}>
            <summary>{label}</summary>
            <SchemaView schema={schema} />
          </details>
        )
      })}
    </div>
  )
}

function PoliciesSection({ node }: { readonly node: WorkflowGraphNode }) {
  if (node.kind !== "step") {
    return null
  }

  const retry = node.metadata.retry
  const concurrency = node.metadata.concurrency
  const compensates = node.metadata.compensates === true

  return (
    <section className="inspector-section">
      <h3>Policies</h3>
      <div className="policy-grid">
        <div>
          <span>Retry</span>
          <code>{retry === undefined ? "none" : prettyJson(retry)}</code>
        </div>
        <div>
          <span>Concurrency</span>
          <code>{concurrency === undefined ? "none" : prettyJson(concurrency)}</code>
        </div>
        <div>
          <span>Compensation</span>
          <code>{compensates ? "yes" : "no"}</code>
        </div>
      </div>
    </section>
  )
}

export function NodeInspector({
  node,
  onClose
}: {
  readonly node: WorkflowGraphNode
  readonly onClose: () => void
}) {
  const reason = typeof node.metadata.reason === "string"
    ? node.metadata.reason
    : node.description

  return (
    <aside className="node-inspector" aria-label="Node inspector">
      <header className="node-inspector-header">
        <div className="node-inspector-title">
          <h3>{node.label}</h3>
          <div className="node-inspector-badges">
            <Badge className={kindClass[node.kind]}>{node.kind}</Badge>
            {node.invocation === undefined ? null : <Badge variant="outline">#{node.invocation}</Badge>}
            {node.repeated ? <Badge variant="outline">repeated</Badge> : null}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X aria-hidden="true" />
          <span className="sr-only">Close inspector</span>
        </Button>
      </header>

      <div className="node-inspector-body">
        {reason === undefined ? null : (
          <blockquote className="reason-block">
            <span>Reason</span>
            {reason}
          </blockquote>
        )}

        <section className="inspector-section">
          <h3>Schemas</h3>
          <SchemaSection schemas={node.schemas} />
        </section>

        <PoliciesSection node={node} />

        {node.metadata.input === undefined ? null : (
          <section className="inspector-section">
            <h3>Trace sample</h3>
            <pre className="trace-sample">{prettyJson(node.metadata.input)}</pre>
          </section>
        )}

        <details className="raw-metadata">
          <summary>Raw metadata</summary>
          <MetadataList value={rawMetadata(node)} />
        </details>
      </div>
    </aside>
  )
}
