import { JsonSchema as EffectJsonSchema, Predicate, Schema, SchemaRepresentation } from "effect"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { DefinedWorkflowTypeId, type DefinedWorkflow } from "../core.ts"
import type { JsonSchema, WorkflowPayload } from "../schemas.ts"
import * as authoring from "../authoring.ts"
import type { WorkflowArtifact } from "./artifact.ts"

const authoringModuleSymbolName = "@mokronos/wfkit/authoring"
const authoringModuleSymbol = Symbol.for(authoringModuleSymbolName)

const installAuthoringModule = (): void => {
  if (Object.hasOwn(globalThis, authoringModuleSymbol)) return
  Object.defineProperty(globalThis, authoringModuleSymbol, {
    value: authoring,
    configurable: false,
    enumerable: false,
    writable: false
  })
}

export interface LoadedWorkflow {
  readonly artifact: WorkflowArtifact
  readonly exportName: string
  readonly workflow: DefinedWorkflow
}

export type ArtifactValidation =
  | { readonly valid: true; readonly loaded: LoadedWorkflow; readonly diagnostics: ReadonlyArray<string> }
  | { readonly valid: false; readonly diagnostics: ReadonlyArray<string> }

const RuntimeJsonSchema = Schema.declare<EffectJsonSchema.JsonSchema>(
  (value): value is EffectJsonSchema.JsonSchema => Predicate.isObject(value)
)

export const decodePersistedJsonSchema = (
  schema: JsonSchema,
  value: WorkflowPayload
): WorkflowPayload => {
  const runtimeSchema = Schema.decodeUnknownSync(RuntimeJsonSchema)(schema)
  const document = EffectJsonSchema.fromSchemaDraft2020_12(runtimeSchema)
  if (!Schema.is(SchemaRepresentation.fromJsonSchemaDocument(document))(value)) {
    throw new Error("Signal payload failed persisted JSON Schema validation")
  }
  return value
}

// A type guard's input has to be wider than the type it proves, so unknown is
// the correct parameter type for one.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const isDefinedWorkflow = (value: unknown): value is DefinedWorkflow => {
  if (!Predicate.isObjectOrArray(value) && !Predicate.isFunction(value)) {
    return false
  }
  return DefinedWorkflowTypeId in value
}

interface WorkflowModule {
  readonly default?: unknown
  // An ES module namespace from a dynamic import holds arbitrary exports; this is
  // what TypeScript itself infers for `await import()`.
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
  readonly [exportName: string]: unknown
}

const importArtifactModule = async (
  artifact: WorkflowArtifact
): Promise<WorkflowModule> => {
  const compiled = await compileWorkflowSource(artifact)
  const directory = await mkdtemp(join(tmpdir(), "wf-artifact-"))
  const modulePath = join(directory, "workflow.mjs")
  try {
    await writeFile(modulePath, compiled)
    return await import(pathToFileURL(modulePath).href)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const compileWorkflowSource = async (artifact: WorkflowArtifact): Promise<string> => {
  installAuthoringModule()
  const source = rewriteWfImports(artifact.source)

  if (Predicate.isNotUndefined(globalThis.Bun) && Bun.Transpiler !== undefined) {
    const transpiler = new Bun.Transpiler({
      loader: "ts",
      target: "bun"
    })
    return `${transpiler.transformSync(source)}\n//# sourceURL=wf:${artifact.id}\n`
  }

  const ts = await import("typescript")
  return `${ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true
    }
  }).outputText}\n//# sourceURL=wf:${artifact.id}\n`
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

const workflowWithArtifactHash = (
  workflow: DefinedWorkflow,
  artifact: WorkflowArtifact,
  exportName: string
): DefinedWorkflow => ({
  ...workflow,
  sourceHash: createHash("sha256")
    .update(artifact.source)
    .update("\0")
    .update(exportName)
    .digest("hex")
})

export const loadWorkflowArtifact = async (
  artifact: WorkflowArtifact
): Promise<LoadedWorkflow> => {
  const module = await importArtifactModule(artifact)

  if (isDefinedWorkflow(module.default)) {
    return {
      artifact,
      exportName: "default",
      workflow: workflowWithArtifactHash(module.default, artifact, "default")
    }
  }

  const candidates: Array<readonly [string, DefinedWorkflow]> = []
  for (const [name, value] of Object.entries(module)) {
    if (isDefinedWorkflow(value)) {
      candidates.push([name, value])
    }
  }

  if (candidates.length === 1) {
    const [exportName, workflow] = candidates[0]!
    return {
      artifact,
      exportName,
      workflow: workflowWithArtifactHash(workflow, artifact, exportName)
    }
  }

  if (candidates.length > 1) {
    const names = candidates.map(([name]) => name).join(", ")
    throw new Error(
      `Workflow ${artifact.id} exports multiple workflows (${names}); mark the one to run with "export default"`
    )
  }

  throw new Error(`Workflow ${artifact.id} did not export a wf workflow`)
}

/**
 * The common validation boundary for the CLI, dashboard, and graph tracer.
 * Evaluation remains explicit here rather than being reimplemented by each
 * caller, so they receive identical import/export diagnostics.
 */
export const validateWorkflowArtifact = async (
  artifact: WorkflowArtifact
): Promise<ArtifactValidation> => {
  try {
    const loaded = await loadWorkflowArtifact(artifact)
    return { valid: true, loaded, diagnostics: [] }
  } catch (error) {
    return {
      valid: false,
      diagnostics: [error instanceof Error ? error.message : String(error)]
    }
  }
}
