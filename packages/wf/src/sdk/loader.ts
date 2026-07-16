import { DefinedWorkflowTypeId, type DefinedWorkflow } from "../core.ts"
import type { WorkflowArtifact } from "./artifact.ts"

export interface LoadedWorkflow {
  readonly artifact: WorkflowArtifact
  readonly exportName: string
  readonly workflow: DefinedWorkflow
}

export const isDefinedWorkflow = (value: unknown): value is DefinedWorkflow => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false
  }
  return DefinedWorkflowTypeId in value
}

interface WorkflowModule {
  readonly default?: unknown
  readonly [exportName: string]: unknown
}

const importArtifactModule = async (
  artifact: WorkflowArtifact
): Promise<WorkflowModule> => {
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
  const authoringModule = import.meta.url.endsWith(".ts") ? "../authoring.ts" : "../authoring.js"
  const wfModuleUrl = new URL(authoringModule, import.meta.url).href
  return source
    .replaceAll(`from "@mokronos/wfkit"`, `from "${wfModuleUrl}"`)
    .replaceAll(`from '@mokronos/wfkit'`, `from '${wfModuleUrl}'`)
    .replaceAll(`import("@mokronos/wfkit")`, `import("${wfModuleUrl}")`)
    .replaceAll(`import('@mokronos/wfkit')`, `import('${wfModuleUrl}')`)
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

  const candidates: Array<readonly [string, DefinedWorkflow]> = []
  for (const [name, value] of Object.entries(module)) {
    if (isDefinedWorkflow(value)) {
      candidates.push([name, value])
    }
  }

  if (candidates.length === 1) {
    const [exportName, workflow] = candidates[0]!
    return { artifact, exportName, workflow }
  }

  if (candidates.length > 1) {
    const names = candidates.map(([name]) => name).join(", ")
    throw new Error(
      `Workflow ${artifact.id} exports multiple workflows (${names}); set exportName in the manifest`
    )
  }

  throw new Error(`Workflow ${artifact.id} did not export a wf workflow`)
}
