import type {
  DefinedWorkflow,
  InMemoryDeterminismState,
  OrchestrationCall,
  OrchestrationKind,
  SecretResolver,
  Step
} from "../core"
import { Schema } from "effect"
import { createInMemoryDeterminismState } from "../core"
import type { WorkflowEvent } from "../events"
import type { WorkflowArtifact } from "./artifact"
import { loadWorkflowArtifact } from "./loader"

interface SchemaAst {
  readonly _tag?: string
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey
    readonly type?: SchemaAst
  }>
  readonly elements?: ReadonlyArray<SchemaAst>
  readonly rest?: ReadonlyArray<SchemaAst>
  readonly types?: ReadonlyArray<SchemaAst>
  readonly literal?: unknown
}

export type WorkflowGraphNodeKind = OrchestrationKind | "start" | "end" | "error"

export interface WorkflowGraphSchemas {
  readonly input?: unknown
  readonly output?: unknown
  readonly errors?: unknown
}

export interface WorkflowGraphNodeSchemas extends WorkflowGraphSchemas {
  readonly signal?: unknown
}

export interface WorkflowGraphNode {
  readonly id: string
  readonly kind: WorkflowGraphNodeKind
  readonly label: string
  readonly invocation?: number
  readonly repeated: boolean
  readonly description?: string
  readonly schemas?: WorkflowGraphNodeSchemas
  readonly metadata: Record<string, unknown>
}

export interface WorkflowGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly label?: string
}

export interface WorkflowGraph {
  readonly workflowName: string
  readonly version: number
  readonly engineName?: string
  readonly sourceHash?: string
  readonly schemas?: WorkflowGraphSchemas
  readonly nodes: ReadonlyArray<WorkflowGraphNode>
  readonly edges: ReadonlyArray<WorkflowGraphEdge>
  readonly calls: ReadonlyArray<{
    readonly kind: OrchestrationKind
    readonly name: string
    readonly counter: number
    readonly branches?: number
  }>
  readonly diagnostics: ReadonlyArray<string>
}

export interface WorkflowArtifactGraph {
  readonly artifact: WorkflowArtifact
  readonly exportName?: string
  readonly graph?: WorkflowGraph
  readonly diagnostics: ReadonlyArray<string>
}

export interface WorkflowGraphOptions<I = unknown> {
  readonly input?: I
  readonly maxNodes?: number
}

const emptySecretResolver: SecretResolver = {
  resolve: (name) => `__secret:${name}__`
}

const nodeId = (kind: WorkflowGraphNodeKind, name: string, invocation: number): string =>
  `${kind}:${name}:${invocation}`

const callKey = (call: OrchestrationCall): string =>
  `${call.kind}:${call.name}:${call.counter}`

const jsonSchemaFor = (schema: unknown): unknown | undefined => {
  try {
    const document = Schema.toJsonSchemaDocument(schema as never) as { readonly schema?: unknown }
    return document.schema
  } catch {
    return undefined
  }
}

const objectWithOptionalSchemas = (
  schemas: WorkflowGraphNodeSchemas
): WorkflowGraphNodeSchemas | undefined => {
  const entries = Object.entries(schemas).filter(([, value]) => value !== undefined)
  return entries.length === 0
    ? undefined
    : Object.fromEntries(entries) as WorkflowGraphNodeSchemas
}

const workflowSchemas = (workflow: DefinedWorkflow): WorkflowGraphSchemas | undefined =>
  objectWithOptionalSchemas({
    input: jsonSchemaFor(workflow.input),
    output: jsonSchemaFor(workflow.output),
    errors: jsonSchemaFor(workflow.errors)
  })

const stepSchemas = (step: Step<any, any, any>): WorkflowGraphNodeSchemas | undefined =>
  objectWithOptionalSchemas({
    input: jsonSchemaFor(step.input),
    output: jsonSchemaFor(step.output),
    errors: jsonSchemaFor(step.errors)
  })

const describeStep = (step: Step<any, any, any>): Record<string, unknown> => ({
  retry: step.retry,
  concurrency: step.concurrency === undefined
    ? undefined
    : {
        limit: step.concurrency.limit,
        keyed: step.concurrency.key !== undefined
      },
  compensates: step.compensate !== undefined
})

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null

const schemaAst = (schema: unknown): SchemaAst | undefined =>
  isRecord(schema) && isRecord(schema.ast) ? schema.ast as SchemaAst : undefined

export const sampleValueForSchema = (schema: unknown): unknown =>
  sampleValueFromAst(schemaAst(schema), new Set())

// `seen` holds the current recursion path only: schema AST nodes are shared
// (t.string is a singleton), so a persistent visited-set would misread the
// second reference to a node as a cycle.
const sampleValueFromAst = (ast: SchemaAst | undefined, seen: Set<SchemaAst>): unknown => {
  if (ast === undefined || seen.has(ast)) {
    return {}
  }
  seen.add(ast)
  try {
    return sampleValueFromAstUnguarded(ast, seen)
  } finally {
    seen.delete(ast)
  }
}

const sampleValueFromAstUnguarded = (ast: SchemaAst, seen: Set<SchemaAst>): unknown => {
  switch (ast._tag) {
    case "String":
      return "sample"
    case "Number":
      return 1
    case "Boolean":
      return true
    case "Void":
    case "Undefined":
      return undefined
    case "Null":
      return null
    case "Date":
      return new Date(0)
    case "Literal":
      return ast.literal
    case "Arrays": {
      const element = ast.rest?.[0] ?? ast.elements?.[0]
      return [sampleValueFromAst(element, seen)]
    }
    case "Union": {
      const candidate = ast.types?.find((item) => item._tag !== "Undefined") ?? ast.types?.[0]
      return sampleValueFromAst(candidate, seen)
    }
    case "Objects": {
      const entries = ast.propertySignatures?.map((property) => [
        property.name,
        sampleValueFromAst(property.type, seen)
      ]) ?? []
      return Object.fromEntries(entries)
    }
    case "Unknown":
    case "Any":
      return {}
    case "Never":
      throw new Error("Cannot create a sample value for Schema.Never")
    default:
      return {}
  }
}

const metadataFromEvents = (events: ReadonlyArray<WorkflowEvent>) => {
  const metadata = new Map<string, Record<string, unknown>>()

  for (const event of events) {
    switch (event.type) {
      case "step.started":
        metadata.set(nodeId("step", event.stepName, event.invocation), {
          input: event.input,
          activityName: event.activityName
        })
        break
      case "sleep.started":
        metadata.set(nodeId("sleep", event.name, event.invocation), {
          duration: event.duration,
          activityName: event.activityName
        })
        break
      case "signal.waiting":
        metadata.set(nodeId("signal", event.name, event.invocation), {
          timeout: event.timeout,
          activityName: event.activityName
        })
        break
      case "code.started":
        metadata.set(nodeId("code", event.name, event.invocation), {
          activityName: event.activityName,
          ...(event.reason === undefined ? {} : { reason: event.reason })
        })
        break
      case "all.started":
        metadata.set(nodeId("all", event.name, event.invocation), {
          activityName: event.activityName,
          branches: event.branches
        })
        break
    }
  }

  return metadata
}

const graphNodeForCall = (
  call: OrchestrationCall,
  options: {
    readonly eventMetadata: ReadonlyMap<string, Record<string, unknown>>
    readonly steps: ReadonlyMap<string, Record<string, unknown>>
    readonly schemas: ReadonlyMap<string, WorkflowGraphNodeSchemas>
    readonly nameCounts: ReadonlyMap<string, number>
  }
): WorkflowGraphNode => {
  const id = nodeId(call.kind, call.name, call.counter)
  const schemas = options.schemas.get(id)
  const metadata: Record<string, unknown> = {
    ...options.eventMetadata.get(id),
    ...options.steps.get(id),
    ...(call.branches === undefined ? {} : { branches: call.branches })
  }
  const description = typeof metadata.reason === "string"
    ? metadata.reason
    : call.counter > 1
      ? `Invocation ${call.counter}`
      : undefined
  return {
    id,
    kind: call.kind,
    label: call.name,
    invocation: call.counter,
    repeated: (options.nameCounts.get(`${call.kind}:${call.name}`) ?? 0) > 1,
    ...(description === undefined ? {} : { description }),
    ...(schemas === undefined ? {} : { schemas }),
    metadata
  }
}

const graphFromTrace = (options: {
  readonly workflow: DefinedWorkflow
  readonly determinism: InMemoryDeterminismState
  readonly events: ReadonlyArray<WorkflowEvent>
  readonly steps: ReadonlyMap<string, Record<string, unknown>>
  readonly schemas: ReadonlyMap<string, WorkflowGraphNodeSchemas>
  readonly diagnostics: ReadonlyArray<string>
  readonly maxNodes: number
}): WorkflowGraph => {
  const eventMetadata = metadataFromEvents(options.events)
  const nameCounts = new Map<string, number>()
  for (const call of options.determinism.calls) {
    nameCounts.set(`${call.kind}:${call.name}`, (nameCounts.get(`${call.kind}:${call.name}`) ?? 0) + 1)
  }

  const calls = options.determinism.calls.slice(0, options.maxNodes)
  const callKeys = new Set(calls.map(callKey))
  const truncated = calls.length < options.determinism.calls.length
  const blocks = options.determinism.blocks
    .filter((block) => callKeys.has(callKey(block.call)))
    .map((block) => ({
      call: block.call,
      branches: block.branches.map((branch) => branch.filter((call) => callKeys.has(callKey(call))))
    }))
  const blockByCall = new Map(blocks.map((block) => [callKey(block.call), block]))
  const branchCallKeys = new Set<string>()
  for (const block of blocks) {
    for (const branch of block.branches) {
      for (const call of branch) {
        branchCallKeys.add(callKey(call))
      }
    }
  }
  const mainCalls = calls.filter((call) => !branchCallKeys.has(callKey(call)))
  const start: WorkflowGraphNode = {
    id: "start",
    kind: "start",
    label: "Start",
    repeated: false,
    metadata: {}
  }
  const end: WorkflowGraphNode = {
    id: "end",
    kind: "end",
    label: truncated ? "Trace truncated" : "End",
    repeated: false,
    metadata: {}
  }
  const nodes: WorkflowGraphNode[] = [start]
  const edges: WorkflowGraphEdge[] = []
  let previousTails: WorkflowGraphNode[] = [start]
  const addEdge = (source: WorkflowGraphNode, target: WorkflowGraphNode, label?: string) => {
    edges.push({
      id: `${source.id}->${target.id}${label === undefined ? "" : `:${label}`}`,
      source: source.id,
      target: target.id,
      ...(label === undefined ? (target.repeated ? { label: "repeat" } : {}) : { label })
    })
  }
  const appendAfterPrevious = (node: WorkflowGraphNode, label?: string) => {
    for (const tail of previousTails) {
      addEdge(tail, node, label)
    }
  }

  for (const call of mainCalls) {
    const node = graphNodeForCall(call, {
      eventMetadata,
      steps: options.steps,
      schemas: options.schemas,
      nameCounts
    })
    nodes.push(node)
    appendAfterPrevious(node)

    const block = blockByCall.get(callKey(call))
    if (block === undefined) {
      previousTails = [node]
      continue
    }

    const branchTails: WorkflowGraphNode[] = []
    block.branches.forEach((branch, branchIndex) => {
      let branchPrevious = node
      if (branch.length === 0) {
        branchTails.push(node)
        return
      }
      branch.forEach((branchCall, callIndex) => {
        const branchNode = graphNodeForCall(branchCall, {
          eventMetadata,
          steps: options.steps,
          schemas: options.schemas,
          nameCounts
        })
        nodes.push(branchNode)
        addEdge(branchPrevious, branchNode, callIndex === 0 ? `branch ${branchIndex + 1}` : undefined)
        branchPrevious = branchNode
      })
      branchTails.push(branchPrevious)
    })
    previousTails = branchTails.length === 0 ? [node] : branchTails
  }
  nodes.push(end)
  for (const tail of previousTails) {
    addEdge(tail, end)
  }
  const schemas = workflowSchemas(options.workflow)

  return {
    workflowName: options.workflow.name,
    version: options.workflow.version,
    engineName: options.workflow.engineName,
    sourceHash: options.workflow.sourceHash,
    ...(schemas === undefined ? {} : { schemas }),
    nodes,
    edges,
    calls,
    diagnostics: truncated
      ? [...options.diagnostics, `Trace stopped after ${options.maxNodes} nodes.`]
      : options.diagnostics
  }
}

export const workflowToGraph = async <I, O, E>(
  workflow: DefinedWorkflow<I, O, E>,
  options: WorkflowGraphOptions<I> = {}
): Promise<WorkflowGraph> => {
  const determinism = createInMemoryDeterminismState()
  const events: WorkflowEvent[] = []
  const steps = new Map<string, Record<string, unknown>>()
  const schemas = new Map<string, WorkflowGraphNodeSchemas>()
  const signalCounts = new Map<string, number>()
  const diagnostics: string[] = []
  const input = options.input ?? sampleValueForSchema(workflow.input) as I

  try {
    await workflow.executeInMemory(input, {
      executionId: `graph-${workflow.name}-${workflow.version}`,
      determinism,
      onEvent: (event) => {
        if (isRecord(event) && typeof event.type === "string") {
          events.push(event as WorkflowEvent)
        }
      },
      stepExecutor: ({ step, invocation }) => {
        const id = nodeId("step", step.name, invocation)
        steps.set(id, describeStep(step))
        const stepNodeSchemas = stepSchemas(step)
        if (stepNodeSchemas !== undefined) {
          schemas.set(id, stepNodeSchemas)
        }
        return sampleValueForSchema(step.output)
      },
      sleep: async () => undefined,
      signalTimeout: async () => undefined,
      signalValue: ({ name, schema }) => {
        const invocation = (signalCounts.get(name) ?? 0) + 1
        signalCounts.set(name, invocation)
        const signalSchema = jsonSchemaFor(schema)
        if (signalSchema !== undefined) {
          schemas.set(nodeId("signal", name, invocation), { signal: signalSchema })
        }
        return sampleValueForSchema(schema)
      },
      secrets: emptySecretResolver
    })
  } catch (error) {
    diagnostics.push(error instanceof Error ? error.message : String(error))
  }

  return graphFromTrace({
    workflow,
    determinism,
    events,
    steps,
    schemas,
    diagnostics,
    maxNodes: options.maxNodes ?? 100
  })
}

export const workflowArtifactToGraph = async (
  artifact: WorkflowArtifact,
  options: WorkflowGraphOptions = {}
): Promise<WorkflowArtifactGraph> => {
  try {
    const loaded = await loadWorkflowArtifact(artifact)
    return {
      artifact,
      exportName: loaded.exportName,
      graph: await workflowToGraph(loaded.workflow, options),
      diagnostics: []
    }
  } catch (error) {
    return {
      artifact,
      diagnostics: [error instanceof Error ? error.message : String(error)]
    }
  }
}
