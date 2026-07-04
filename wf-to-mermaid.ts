#!/usr/bin/env bun
import ts from "typescript"
import { readFileSync, writeFileSync } from "fs"

// Parses a workflow authored against the `wf` module (the `ctx.*` surface) and
// renders a Mermaid flowchart. The parser only needs to recognize:
//   - ctx.* primitive calls  -> graph nodes
//   - (later) if/for/parallel -> structure
// Everything else (transforms inlined, bindings) is opaque and ignored.
//
// NOTE: linear flows only for now — branch/loop/parallel support is a TODO.

// ── Workflow step types ──
type Step =
  | { kind: "activity"; name: string; retry?: number; compensate?: boolean }
  | { kind: "step"; description: string; code: string } // pure, non-durable
  | { kind: "sleep"; duration: string }
  | { kind: "signal_fork"; signal: string; after?: string }
  | { kind: "signal_await"; signal: string }

interface Node {
  id: string
  label: string
  class?: string
  shape?: string
}
interface Edge {
  from: string
  to: string
  label?: string
}

// ── Helpers ──
function mermaidEsc(s: string): string {
  return s
    .replace(/"/g, "#quot;")
    .replace(/\(/g, "#40;")
    .replace(/\)/g, "#41;")
}

function literalText(n: ts.Node | undefined): string | undefined {
  if (!n) return
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.getText().replace(/`/g, "")
}

// ── Extractor ──
function extractSteps(code: string): {
  steps: Step[]
  wfName: string
  payloadStr: string
} {
  const sf = ts.createSourceFile("workflow.ts", code, ts.ScriptTarget.Latest, true)
  let wfName = "Workflow"
  let payloadStr = ""
  let ctxName = "ctx"
  const steps: Step[] = []
  const signalNames = new Map<string, string>() // variable name -> signal label

  // Read a property off an object literal as a string literal.
  function objString(obj: ts.ObjectLiteralExpression, key: string): string | undefined {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key) {
        return literalText(p.initializer)
      }
    }
  }

  // Resolve a signal argument (an identifier) to its declared label.
  function signalLabel(arg: ts.Node | undefined): string {
    if (arg && ts.isIdentifier(arg)) return signalNames.get(arg.text) ?? arg.text
    return "signal"
  }

  function visit(node: ts.Node, parents: ts.Node[]) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression

      // defineWorkflow({...}, function* (input, ctx) {...})
      if (ts.isIdentifier(expr) && expr.text === "defineWorkflow") {
        const cfg = node.arguments[0]
        if (cfg && ts.isObjectLiteralExpression(cfg)) {
          wfName = objString(cfg, "name") ?? wfName
          for (const prop of cfg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "payload" &&
              ts.isObjectLiteralExpression(prop.initializer)
            ) {
              const fields: string[] = []
              for (const f of prop.initializer.properties) {
                if (ts.isPropertyAssignment(f) && ts.isIdentifier(f.name)) {
                  fields.push(`${f.name.text}: ${f.initializer.getText().replace(/^t\./, "")}`)
                }
              }
              payloadStr = fields.join(", ")
            }
          }
        }
        const body = node.arguments[1]
        if (body && (ts.isFunctionExpression(body) || ts.isArrowFunction(body))) {
          const ctxParam = body.parameters[1]
          if (ctxParam && ts.isIdentifier(ctxParam.name)) ctxName = ctxParam.name.text
        }
      }

      // defineSignal("Name") assigned to a const -> remember the variable.
      if (ts.isIdentifier(expr) && expr.text === "defineSignal") {
        const label = literalText(node.arguments[0]) ?? "signal"
        for (let i = parents.length - 1; i >= 0; i--) {
          const p = parents[i]!
          if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
            signalNames.set(p.name.text, label)
            break
          }
        }
      }

      // ctx.<method>(...)
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === ctxName
      ) {
        const method = expr.name.text
        const args = node.arguments

        if (method === "activity") {
          const name = literalText(args[0]) ?? "Unnamed"
          const step: Extract<Step, { kind: "activity" }> = { kind: "activity", name }
          const opts = args[2]
          if (opts && ts.isObjectLiteralExpression(opts)) {
            for (const p of opts.properties) {
              if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) {
                if (p.name.text === "retry" && ts.isNumericLiteral(p.initializer)) {
                  step.retry = Number(p.initializer.text)
                }
                if (p.name.text === "compensate") step.compensate = true
              }
            }
          }
          steps.push(step)
        } else if (method === "step") {
          steps.push({
            kind: "step",
            description: literalText(args[0]) ?? "step",
            code: args[1]?.getText() ?? ""
          })
        } else if (method === "sleep") {
          steps.push({ kind: "sleep", duration: literalText(args[0]) ?? "?" })
        } else if (method === "completeSignalAfter") {
          steps.push({
            kind: "signal_fork",
            signal: signalLabel(args[0]),
            after: literalText(args[1])
          })
        } else if (method === "waitForSignal") {
          steps.push({ kind: "signal_await", signal: signalLabel(args[0]) })
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, [...parents, node]))
  }

  visit(sf, [])
  return { steps, wfName, payloadStr }
}

// ── Graph builder ──
function buildGraph(steps: Step[], wfName: string, payloadStr: string): {
  nodes: Node[]
  edges: Edge[]
} {
  const nodes: Node[] = []
  const edges: Edge[] = []
  let i = 0
  const nid = () => `N${i++}`

  const startId = nid()
  nodes.push({
    id: startId,
    label: payloadStr ? `${wfName}<br/>(${payloadStr})` : wfName,
    shape: "start"
  })
  let lastId = startId
  let pendingLabel: string | undefined

  function advance(to: string) {
    edges.push({ from: lastId, to, label: pendingLabel })
    pendingLabel = undefined
    lastId = to
  }

  for (const step of steps) {
    switch (step.kind) {
      case "activity": {
        const id = nid()
        const badge = step.retry ? `<br/>retry ${step.retry}×` : ""
        nodes.push({ id, label: `${step.name}${badge}`, class: "activity" })
        advance(id)
        if (step.compensate) {
          const cid = nid()
          nodes.push({ id: cid, label: "compensate", class: "compensation" })
          edges.push({ from: id, to: cid, label: "on failure" })
        }
        break
      }
      case "step": {
        const id = nid()
        nodes.push({ id, label: step.description, class: "step" })
        advance(id)
        break
      }
      case "sleep": {
        const id = nid()
        nodes.push({ id, label: `sleep ${step.duration}`, class: "sleep" })
        advance(id)
        break
      }
      case "signal_fork": {
        // A forked side-branch off the current node; main flow continues.
        const id = nid()
        const after = step.after ? `<br/>after ${step.after}` : ""
        nodes.push({ id, label: `complete ${step.signal}${after}`, class: "fork" })
        edges.push({ from: lastId, to: id, label: "fork" })
        break
      }
      case "signal_await": {
        const id = nid()
        nodes.push({ id, label: `await ${step.signal}`, class: "signal" })
        advance(id)
        break
      }
    }
  }

  const endId = nid()
  nodes.push({ id: endId, label: "End", shape: "end" })
  advance(endId)
  return { nodes, edges }
}

// ── Mermaid renderer ──
function renderMermaid(nodes: Node[], edges: Edge[]): string {
  let out = "flowchart TD\n"
  out += "    classDef activity fill:#e1f5fe,stroke:#0288d1,stroke-width:2px\n"
  out += "    classDef step fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray:5 5\n"
  out += "    classDef sleep fill:#fff3e0,stroke:#f57c00,stroke-width:2px\n"
  out += "    classDef signal fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px\n"
  out += "    classDef fork fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px\n"
  out += "    classDef compensation fill:#ffebee,stroke:#c62828,stroke-width:2px\n"

  for (const n of nodes) {
    const label = mermaidEsc(n.label)
    if (n.shape === "start") out += `    ${n.id}("${label}")\n`
    else if (n.shape === "end") out += `    ${n.id}(["${label}"])\n`
    else out += `    ${n.id}["${label}"]\n`
    if (n.class) out += `    class ${n.id} ${n.class};\n`
  }
  for (const e of edges) {
    out += e.label
      ? `    ${e.from} -->|${mermaidEsc(e.label)}| ${e.to}\n`
      : `    ${e.from} --> ${e.to}\n`
  }
  return out
}

// ── Main ──
const args = process.argv.slice(2)
const htmlFlagIdx = args.indexOf("--html")
let htmlPath: string | undefined
let filePath: string | undefined

if (htmlFlagIdx >= 0) {
  htmlPath = args[htmlFlagIdx + 1]
  filePath = args[htmlFlagIdx + 2]
  if (!htmlPath || htmlPath.startsWith("--") || !filePath) {
    console.error("Usage: bun run wf-to-mermaid.ts --html <output.html> <workflow-file.ts>")
    process.exit(1)
  }
} else {
  filePath = args[0]
  if (!filePath) {
    console.error("Usage: bun run wf-to-mermaid.ts [--html <out.html>] <workflow-file.ts>")
    process.exit(1)
  }
}

const code = readFileSync(filePath, "utf-8")
const { steps, wfName, payloadStr } = extractSteps(code)
const { nodes, edges } = buildGraph(steps, wfName, payloadStr)
const mermaid = renderMermaid(nodes, edges)

if (htmlPath) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Workflow Diagram</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<style>
  body { margin: 0; padding: 24px; background: #1e1e2e; display: flex; justify-content: center; }
  .mermaid { background: #fff; padding: 24px; border-radius: 12px; max-width: 100%; }
</style>
</head>
<body>
<pre class="mermaid" id="diagram">
${mermaid}
</pre>
<script>
  mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
</script>
</body>
</html>`
  writeFileSync(htmlPath, html)
  console.log(`Wrote ${htmlPath}`)
} else {
  console.log(mermaid)
}
