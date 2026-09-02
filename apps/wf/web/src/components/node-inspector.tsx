import { Predicate } from "effect"
import { X } from "lucide-react"

import { MetadataList } from "@/components/metadata-list"
import { SchemaView } from "@/components/schema-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { WorkflowGraphNode, WorkflowGraphNodeMetadata, WorkflowGraphNodeSchemas } from "@/lib/api"
import { prettyJson } from "@/lib/format"
import { kindClass } from "./workflow-node"

const schemaLabels = [["input", "Input"], ["output", "Output"], ["errors", "Errors"], ["signal", "Signal payload"]] as const

const nodePurpose = {
  start: "Entry point for this workflow trace.", end: "Terminal point for this workflow trace.", step: "Runs a named step with a typed input and output.", sleep: "Pauses workflow progress for the declared duration.", signal: "Waits for an external typed signal, optionally until a timeout.", now: "Records the current time so replays use the same timestamp.", random: "Records a random number so replays use the same value.", code: "Runs a named deterministic code block and records its result.", all: "Runs its branches concurrently and preserves their result order.", error: "Marks an error path in the workflow trace."
} satisfies Record<WorkflowGraphNode["kind"], string>

const rawMetadata = (node: WorkflowGraphNode): WorkflowGraphNodeMetadata => {
  const { code: _code, input: _input, retry: _retry, concurrency: _concurrency, compensates: _compensates, reason: _reason, ...rest } = node.metadata
  return rest
}

const nodeFacts = (node: WorkflowGraphNode): ReadonlyArray<readonly [string, string]> => {
  const shared = node.metadata.activityName === undefined ? [] : [["Activity", node.metadata.activityName] as const]
  switch (node.kind) {
    case "step": return [...shared, ["Invocation", String(node.invocation ?? 1)], ["Compensation", node.metadata.compensates === true ? "available" : "none"]]
    case "all": return [...shared, ["Branches", String(node.metadata.branches ?? 0)], ["Result", "ordered tuple of branch results"]]
    case "sleep": return [...shared, ["Duration", String(node.metadata.duration ?? "not captured")]]
    case "signal": return [...shared, ["Timeout", String(node.metadata.timeout ?? "wait indefinitely")]]
    case "now": return [["Output", "timestamp"]]
    case "random": return [["Output", "number from 0 (inclusive) to 1 (exclusive)"]]
    case "code": return [...shared, ["Invocation", String(node.invocation ?? 1)]]
    case "start": return [["Input", "workflow input"]]
    case "end": return [["Output", "workflow result"]]
    case "error": return [["Output", "workflow error"]]
  }
}

function SchemaSection({ schemas }: { readonly schemas: WorkflowGraphNodeSchemas | undefined }) {
  const entries = schemaLabels.map(([key, label]) => [key, label, schemas?.[key]] as const).filter(([, , schema]) => schema !== undefined)
  if (entries.length === 0) return <p className="muted-copy">This node has no independently declared schema.</p>
  return <div className="inspector-section-grid">{entries.map(([key, label, schema]) => <details key={key} className="schema-panel" open={key === "input" || key === "output" || key === "signal"}><summary>{label}</summary><SchemaView schema={schema} /></details>)}</div>
}

function PoliciesSection({ node }: { readonly node: WorkflowGraphNode }) {
  if (node.kind !== "step") return null
  const { retry, concurrency, compensates, integration } = node.metadata
  return <section className="inspector-section"><h3>Execution policy</h3><div className="policy-grid">
    <div><span>Retry</span><code>{retry === undefined ? "none" : prettyJson(retry)}</code></div>
    <div><span>Concurrency</span><code>{concurrency === undefined ? "unbounded" : prettyJson(concurrency)}</code></div>
    <div><span>Compensation</span><code>{compensates === true ? "available" : "none"}</code></div>
    {integration === undefined ? null : <div><span>Integration</span><code>{prettyJson(integration)}</code></div>}
  </div></section>
}

const codeTokenPattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:async|await|const|let|return|if|else|for|of|function|throw|new|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b)/
const codeTokenClass = (token: string): string => token.startsWith("//") || token.startsWith("/*") ? "comment" : token.startsWith("\"") || token.startsWith("'") || token.startsWith("`") ? "string" : /^\d/.test(token) ? "number" : "keyword"

function CodePreview({ code }: { readonly code: string }) {
  return <section className="inspector-section"><h3>Code</h3><pre className="code-view"><code>{code.split(codeTokenPattern).map((token, index) => token === "" ? null : <span key={`${index}-${token}`} className={codeTokenPattern.test(token) ? codeTokenClass(token) : undefined}>{token}</span>)}</code></pre></section>
}

export function NodeInspector({ node, onClose }: { readonly node: WorkflowGraphNode; readonly onClose: () => void }) {
  const reason = Predicate.isString(node.metadata.reason) ? node.metadata.reason : node.description
  return <aside className="node-inspector" aria-label="Node inspector">
    <header className="node-inspector-header"><div className="node-inspector-title"><h3>{node.label}</h3><div className="node-inspector-badges"><Badge className={kindClass[node.kind]}>{node.kind}</Badge>{node.repeated ? <Badge variant="outline">repeated</Badge> : null}</div></div><Button variant="ghost" size="icon" onClick={onClose}><X aria-hidden="true" /><span className="sr-only">Close inspector</span></Button></header>
    <div className="node-inspector-body">
      <section className="inspector-section"><h3>At a glance</h3><p className="node-purpose">{nodePurpose[node.kind]}</p><dl className="node-facts">{nodeFacts(node).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      {reason === undefined ? null : <blockquote className="reason-block"><span>Reason</span>{reason}</blockquote>}
      <section className="inspector-section"><h3>Types</h3><SchemaSection schemas={node.schemas} /></section>
      <PoliciesSection node={node} />
      {node.kind === "code" && node.metadata.code !== undefined ? <CodePreview code={node.metadata.code} /> : null}
      {node.metadata.input === undefined ? null : <section className="inspector-section"><h3>Trace input</h3><pre className="trace-sample">{prettyJson(node.metadata.input)}</pre></section>}
      <details className="raw-metadata"><summary>Raw trace metadata</summary><MetadataList value={rawMetadata(node)} /></details>
    </div>
  </aside>
}
