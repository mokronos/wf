#!/usr/bin/env bun
import ts from "typescript"
import { readFileSync, writeFileSync } from "fs"

// ── Graph types ──
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

// ── Workflow step types ──
interface ActivityInfo {
  name: string
  retryTimes?: number
  compensationLog?: string
}
type Step =
  | { kind: "activity"; info: ActivityInfo }
  | { kind: "sleep"; duration: string }
  | { kind: "deferred_make"; name: string }
  | { kind: "deferred_signal"; after: string }
  | { kind: "deferred_await" }

// ── Helpers ──
function slug(s: string) { return s.replace(/[^a-zA-Z0-9]/g, "_") }

function mermaidEsc(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/\(/g, "#40;").replace(/\)/g, "#41;")
}

function textOf(n: ts.Node, sf: ts.SourceFile): string {
  return n.getText(sf)
}

function isCallTo(
  expr: ts.Expression,
  mod: string,
  fn: string,
): boolean {
  return (
    ts.isPropertyAccessExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === mod &&
    expr.name.text === fn
  )
}

function isTaggedError(n: ts.Node, sf: ts.SourceFile): boolean {
  const text = n.getText(sf)
  return /class\s+\w+\s+extends\s+Schema\.TaggedError/.test(text)
}

// ── Extractor ──
function extractSteps(code: string): { steps: Step[]; wfName: string; payloadStr: string } {
  const sf = ts.createSourceFile("workflow.ts", code, ts.ScriptTarget.Latest, true)
  let wfName = "Workflow"
  let payloadStr = ""
  const steps: Step[] = []
  const deferredVarMap = new Map<string, string>() // variable name -> deferred name

  function getStringArg(call: ts.CallExpression, propName: string): string | undefined {
    if (call.arguments.length === 0) return
    const arg = call.arguments[0]!
    if (!ts.isObjectLiteralExpression(arg)) return
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === propName) {
        if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text
      }
    }
  }

  function extractObjectString(obj: ts.ObjectLiteralExpression, key: string): string | undefined {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
        if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text
      }
    }
  }

  function getRetryTimes(call: ts.CallExpression): number | undefined {
    // Activity.retry({ times: N }) or Activity.retry({ maxRetries: N })
    if (call.arguments.length === 0) return
    const arg = call.arguments[0]!
    if (!ts.isObjectLiteralExpression(arg)) return
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        if ((prop.name.text === "times" || prop.name.text === "maxRetries") &&
            ts.isNumericLiteral(prop.initializer)) {
          return Number(prop.initializer.text)
        }
      }
    }
  }

  function findPipeArgs(call: ts.CallExpression, parents: ts.Node[]): ts.Node[] | undefined {
    // parents[last] = PropertyAccessExpression(.pipe) — call's direct parent
    // parents[last-1] = CallExpression(.pipe call) — the enclosing .pipe(...)
    if (parents.length < 2) return
    const directParent = parents[parents.length - 1]!
    if (!ts.isPropertyAccessExpression(directParent)) return
    if (directParent.name.text !== "pipe") return
    // Ensure the PropertyAccessExpression's expression IS this call
    if (directParent.expression !== call) return
    const pipeCall = parents[parents.length - 2]!
    if (!ts.isCallExpression(pipeCall)) return
    return pipeCall.arguments
  }

  function visit(node: ts.Node, parents: ts.Node[]) {
    // Call expressions
    if (ts.isCallExpression(node)) {
      const expr = node.expression

      // Workflow.make({...})
      if (isCallTo(expr, "Workflow", "make")) {
        if (node.arguments.length > 0 && ts.isObjectLiteralExpression(node.arguments[0]!)) {
          const obj = node.arguments[0]!
          wfName = extractObjectString(obj, "name") ?? wfName
          // payload
          for (const prop of obj.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "payload") {
              if (ts.isObjectLiteralExpression(prop.initializer)) {
                const fields: string[] = []
                for (const f of prop.initializer.properties) {
                  if (ts.isPropertyAssignment(f) && ts.isIdentifier(f.name)) {
                    let ftype = textOf(f.initializer, sf)
                    ftype = ftype.replace(/^Schema\./, "") // shorten Schema.String -> String
                    fields.push(`${f.name.text}: ${ftype}`)
                  }
                }
                payloadStr = fields.join(", ")
              }
            }
          }
        }
      }

      // Activity.make({...})
      if (isCallTo(expr, "Activity", "make")) {
        const name = getStringArg(node, "name") ?? "Unnamed"
        const info: ActivityInfo = { name }

        // Check if this is inside a .pipe() chain
        const pipeArgs = findPipeArgs(node, parents)
        if (pipeArgs) {
          for (const arg of pipeArgs) {
            if (ts.isCallExpression(arg)) {
              const argExpr = arg.expression
              // Activity.retry({...}) or Effect.retry({...})
              if (isCallTo(argExpr, "Activity", "retry") || isCallTo(argExpr, "Effect", "retry")) {
                info.retryTimes = getRetryTimes(arg)
              }
              // .withCompensation(...)  — could be on Workflow reference
              if (ts.isPropertyAccessExpression(argExpr) && argExpr.name.text === "withCompensation") {
                // Find Effect.log inside the callback
                const logText = extractLogFromCompensation(arg, sf)
                if (logText) info.compensationLog = logText
              }
            }
          }
        }

        // Also check direct parent for non-pipe chains (e.g. variable then .pipe separately)
        steps.push({ kind: "activity", info })
      }

      // DurableClock.sleep({...})
      if (isCallTo(expr, "DurableClock", "sleep")) {
        const duration = getStringArg(node, "duration") ?? "?"
        steps.push({ kind: "sleep", duration })
      }

      // DurableDeferred.make("...")
      if (isCallTo(expr, "DurableDeferred", "make")) {
        const name = node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!)
          ? node.arguments[0]!.text : "Deferred"
        steps.push({ kind: "deferred_make", name })

        // Track which variable this is assigned to
        for (let i = parents.length - 1; i >= 0; i--) {
          const p = parents[i]!
          if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
            deferredVarMap.set(p.name.text, name)
            break
          }
          if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(p.left)) {
            deferredVarMap.set(p.left.text, name)
            break
          }
        }
      }

      // DurableDeferred.succeed / done
      if (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "DurableDeferred" &&
          (expr.name.text === "succeed" || expr.name.text === "done")) {
        // Check for Effect.delay in the pipe chain
        const pipeArgs = findPipeArgs(node, parents)
        let after = ""
        if (pipeArgs) {
          for (const arg of pipeArgs) {
            if (ts.isCallExpression(arg) && isCallTo(arg.expression, "Effect", "delay")) {
              if (arg.arguments.length > 0 && ts.isStringLiteral(arg.arguments[0]!)) {
                after = arg.arguments[0]!.text
              }
            }
          }
        }
        steps.push({ kind: "deferred_signal", after })
      }

      // DurableDeferred.await
      if (isCallTo(expr, "DurableDeferred", "await")) {
        steps.push({ kind: "deferred_await" })
      }

      // Activity.retry standalone (if not in pipe)
      if (isCallTo(expr, "Activity", "retry")) {
        // Already handled as part of pipe chain above
      }
    }

    // Recurse
    ts.forEachChild(node, child => visit(child, [...parents, node]))
  }

  visit(sf, [])

  return { steps, wfName, payloadStr }
}

function extractLogFromCompensation(compCall: ts.CallExpression, sf: ts.SourceFile): string | undefined {
  // Search through the callback body for Effect.log(...)
  function searchLog(node: ts.Node): string | undefined {
    if (ts.isCallExpression(node)) {
      const expr = node.expression
      if (isCallTo(expr, "Effect", "log")) {
        const a = node.arguments[0]
        if (a && ts.isStringLiteral(a)) return a.text
        if (a && ts.isNoSubstitutionTemplateLiteral(a)) return a.text
      }
    }
    let result: string | undefined
    ts.forEachChild(node, child => {
      if (!result) result = searchLog(child)
    })
    return result
  }
  return searchLog(compCall)
}

// ── Graph builder ──
function buildGraph(steps: Step[], wfName: string, payloadStr: string): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const nid = (() => { let i = 0; return () => `N${i++}` })()

  const labelText = payloadStr ? `${wfName}<br/>(${payloadStr})` : wfName
  const startId = nid()
  nodes.push({ id: startId, label: labelText, shape: "start" })
  let lastId = startId
  let hadRetry = false

  function advance(to: string, label?: string) {
    edges.push({ from: lastId, to, label })
    lastId = to
  }

  let deferredBranchNode: string | undefined // last deferred_make node for parallel signal

  for (const step of steps) {
    switch (step.kind) {
      case "activity": {
        const actId = nid()
        nodes.push({ id: actId, label: `Activity: ${step.info.name}`, class: "activity" })
        advance(actId)
        hadRetry = false

        if (step.info.retryTimes) {
          const retId = nid()
          nodes.push({ id: retId, label: `Retry: ${step.info.retryTimes}×`, class: "retry" })
          advance(retId)
          hadRetry = true
        }

        if (step.info.compensationLog) {
          const compId = nid()
          nodes.push({ id: compId, label: "Compensation", class: "compensation" })
          edges.push({ from: lastId, to: compId, label: "failure" })
          const logId = nid()
          nodes.push({ id: logId, label: `Log: ${step.info.compensationLog}`, class: "log" })
          edges.push({ from: compId, to: logId })
        }
        break
      }
      case "sleep": {
        const sid = nid()
        nodes.push({ id: sid, label: `Sleep: ${step.duration}`, class: "sleep" })
        advance(sid, hadRetry ? "success" : undefined)
        hadRetry = false
        break
      }
      case "deferred_make": {
        const did = nid()
        nodes.push({ id: did, label: `Deferred: ${step.name}`, class: "deferred" })
        advance(did)
        deferredBranchNode = did
        break
      }
      case "deferred_signal": {
        // Branch from the deferred node — don't advance main flow
        if (deferredBranchNode) {
          const after = step.after ? ` (after ${step.after})` : ""
          const fid = nid()
          nodes.push({ id: fid, label: `Fork: signal${after}`, class: "fork" })
          edges.push({ from: deferredBranchNode, to: fid, label: "fork" })
        }
        break
      }
      case "deferred_await": {
        const wid = nid()
        nodes.push({ id: wid, label: "Wait: await", class: "deferred" })
        advance(wid)
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
  out += "    classDef sleep fill:#fff3e0,stroke:#f57c00,stroke-width:2px\n"
  out += "    classDef deferred fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px\n"
  out += "    classDef compensation fill:#ffebee,stroke:#c62828,stroke-width:2px\n"
  out += "    classDef retry fill:#fff8e1,stroke:#f9a825,stroke-width:2px\n"
  out += "    classDef log fill:#f5f5f5,stroke:#9e9e9e,stroke-dasharray:5,5\n"
  out += "    classDef fork fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px\n"

  for (const n of nodes) {
    const label = mermaidEsc(n.label)
    if (n.shape === "start") {
      out += `    ${n.id}("${label}")\n`
    } else if (n.shape === "end") {
      out += `    ${n.id}(["${label}"])\n`
    } else {
      out += `    ${n.id}["${label}"]\n`
    }
    if (n.class) out += `    class ${n.id} ${n.class};\n`
  }

  for (const e of edges) {
    if (e.label) {
      out += `    ${e.from} -->|${mermaidEsc(e.label)}| ${e.to}\n`
    } else {
      out += `    ${e.from} --> ${e.to}\n`
    }
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
