import { DefinedWorkflowTypeId, type DefinedWorkflow } from "../core.ts"
import * as authoring from "../authoring.ts"
import type { WorkflowArtifact } from "./artifact.ts"

const authoringModuleSymbolName = "@mokronos/wfkit/authoring"
const authoringModuleSymbol = Symbol.for(authoringModuleSymbolName)
Object.defineProperty(globalThis, authoringModuleSymbol, {
  value: authoring,
  configurable: false,
  enumerable: false,
  writable: false
})

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
  const authoringExpression = `globalThis[Symbol.for("${authoringModuleSymbolName}")]`
  return source
    .replace(
      /import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']@mokronos\/wfkit["'];?/g,
      (_match, typeOnly: string | undefined, specifiers: string) => {
        if (typeOnly !== undefined) return ""
        const bindings = specifiers
          .split(",")
          .map((specifier) => specifier.trim())
          .filter((specifier) => specifier.length > 0 && !specifier.startsWith("type "))
          .map((specifier) => specifier.replace(/\s+as\s+/, ": "))
          .join(", ")
        return bindings.length === 0 ? "" : `const { ${bindings} } = ${authoringExpression};`
      }
    )
    .replace(
      /import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']@mokronos\/wfkit["'];?/g,
      `const $1 = ${authoringExpression};`
    )
    .replaceAll(`import("@mokronos/wfkit")`, `Promise.resolve(${authoringExpression})`)
    .replaceAll(`import('@mokronos/wfkit')`, `Promise.resolve(${authoringExpression})`)
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
