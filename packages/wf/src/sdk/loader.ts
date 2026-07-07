import type { DefinedWorkflow } from "../core"
import type { WorkflowArtifact } from "./artifact"

export interface LoadedWorkflow {
  readonly artifact: WorkflowArtifact
  readonly exportName: string
  readonly workflow: DefinedWorkflow
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const isDefinedWorkflow = (value: unknown): value is DefinedWorkflow => {
  if (!isRecord(value)) {
    return false
  }

  // The engine workflow is a callable object (a function with workflow fields
  // assigned), so accept both shapes.
  const workflow = value.workflow as Record<string, unknown> | ((...args: Array<unknown>) => unknown) | undefined
  return (
    (isRecord(workflow) || typeof workflow === "function") &&
    typeof (workflow as Record<string, unknown>).execute === "function" &&
    "layer" in value &&
    typeof value.execute === "function"
  )
}

const importArtifactModule = async (
  artifact: WorkflowArtifact
): Promise<Record<string, unknown>> => {
  const compiled = await compileWorkflowSource(artifact)
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  return await import(url)
}

const compileWorkflowSource = async (artifact: WorkflowArtifact): Promise<string> => {
  const source = rewriteWfImports(artifact.source)

  if (typeof Bun !== "undefined" && Bun.Transpiler !== undefined) {
    const transpiler = new Bun.Transpiler({
      loader: "ts",
      target: "bun"
    })
    return `${transpiler.transformSync(source)}\n//# sourceURL=wf:${artifact.id}@${artifact.version}\n`
  }

  const ts = await import("typescript")
  return `${ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true
    }
  }).outputText}\n//# sourceURL=wf:${artifact.id}@${artifact.version}\n`
}

const rewriteWfImports = (source: string): string => {
  const wfModuleUrl = new URL("../authoring.ts", import.meta.url).href
  return source
    .replaceAll(`from "wf"`, `from "${wfModuleUrl}"`)
    .replaceAll(`from 'wf'`, `from '${wfModuleUrl}'`)
    .replaceAll(`import("wf")`, `import("${wfModuleUrl}")`)
    .replaceAll(`import('wf')`, `import('${wfModuleUrl}')`)
}

export const loadWorkflowArtifact = async (
  artifact: WorkflowArtifact
): Promise<LoadedWorkflow> => {
  const module = await importArtifactModule(artifact)

  if (artifact.exportName !== undefined) {
    const exported = module[artifact.exportName]
    if (isDefinedWorkflow(exported)) {
      return { artifact, exportName: artifact.exportName, workflow: exported }
    }
    throw new Error(
      `Workflow ${artifact.id} expected export ${artifact.exportName}, but it was not a wf workflow`
    )
  }

  if (isDefinedWorkflow(module.default)) {
    return { artifact, exportName: "default", workflow: module.default }
  }

  const candidates = Object.entries(module).filter(([, value]) => isDefinedWorkflow(value))

  if (candidates.length === 1) {
    const [exportName, workflow] = candidates[0]!
    return { artifact, exportName, workflow: workflow as DefinedWorkflow }
  }

  if (candidates.length > 1) {
    const names = candidates.map(([name]) => name).join(", ")
    throw new Error(
      `Workflow ${artifact.id} exports multiple workflows (${names}); set exportName in the manifest`
    )
  }

  throw new Error(`Workflow ${artifact.id} did not export a wf workflow`)
}
