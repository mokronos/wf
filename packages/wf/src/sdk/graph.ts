import type {
  DefinedWorkflow,
  InMemoryDeterminismState,
  OrchestrationCall,
  SecretResolver,
  Step
} from "../core"
import { Schema } from "effect"
import { createInMemoryDeterminismState } from "../core"
import type { WorkflowEvent } from "../events"
import {
  jsonSchemaOf,
  type JsonSchema,
  type WorkflowArtifactGraph,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphNodeKind,
  type WorkflowGraphNodeMetadata,
  type WorkflowGraphNodeSchemas,
  type WorkflowGraphSchemas
} from "../schemas"
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

export type {
  WorkflowArtifactGraph,
  WorkflowGraph,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeMetadata,
  WorkflowGraphNodeSchemas,
  WorkflowGraphSchemas
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

const jsonSchemaFor = jsonSchemaOf

const objectWithOptionalSchemas = (schemas: WorkflowGraphNodeSchemas): WorkflowGraphNodeSchemas | undefined =>
  schemas.input === undefined &&
    schemas.output === undefined &&
    schemas.errors === undefined &&
    schemas.signal === undefined
    ? undefined
    : schemas

const workflowSchemas = (workflow: DefinedWorkflow): WorkflowGraphSchemas | undefined => {
  const input = jsonSchemaFor(workflow.input)
  const output = jsonSchemaFor(workflow.output)
  const errors = jsonSchemaFor(workflow.errors)
  return objectWithOptionalSchemas({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(errors === undefined ? {} : { errors })
  })
}

const stepSchemas = (step: Step<any, any, any>): WorkflowGraphNodeSchemas | undefined => {
  const input = jsonSchemaFor(step.input)
  const output = jsonSchemaFor(step.output)
  const errors = jsonSchemaFor(step.errors)
  return objectWithOptionalSchemas({
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(errors === undefined ? {} : { errors })
  })
}

const describeStep = (step: Step<any, any, any>): WorkflowGraphNodeMetadata => ({
  ...(step.retry === undefined ? {} : { retry: step.retry }),
  ...(step.concurrency === undefined
    ? {}
    : {
        concurrency: {
          limit: step.concurrency.limit,
          keyed: step.concurrency.key !== undefined
        }
      }),
  compensates: step.compensate !== undefined
})

const schemaAst = (schema: unknown): SchemaAst | undefined =>
  Schema.isSchema(schema) ? schema.ast as SchemaAst : undefined

export const sampleValueForSchema = (schema: unknown): unknown =>
  sampleValueFromAst(schemaAst(schema), new Set())

/** Sample value for a JSON Schema document (e.g. PendingSignal.payloadSchema),
 *  mirroring the placeholders of sampleValueForSchema. */
export const sampleValueForJsonSchema = (schema: JsonSchema, depth = 0): unknown => {
  if (depth > 8) {
    return {}
  }
  if (schema.const !== undefined) {
    return schema.const
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum[0]
  }
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0]
  if (alternative !== undefined) {
    return sampleValueForJsonSchema(alternative, depth + 1)
  }
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case "string":
      return "sample"
    case "number":
    case "integer":
      return 1
    case "boolean":
      return true
    case "null":
      return null
    case "array":
      return schema.items === undefined ? [] : [sampleValueForJsonSchema(schema.items, depth + 1)]
    case "object": {
      const properties = schema.properties ?? {}
      const required = schema.required
      const entries = Object.entries(properties)
        .filter(([key]) => required === undefined || required.includes(key))
        .map(([key, property]) => [key, sampleValueForJsonSchema(property, depth + 1)])
      return Object.fromEntries(entries)
    }
    default:
      return {}
  }
}

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
  const metadata = new Map<string, WorkflowGraphNodeMetadata>()

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
    readonly eventMetadata: ReadonlyMap<string, WorkflowGraphNodeMetadata>
    readonly steps: ReadonlyMap<string, WorkflowGraphNodeMetadata>
    readonly schemas: ReadonlyMap<string, WorkflowGraphNodeSchemas>
    readonly nameCounts: ReadonlyMap<string, number>
  }
): WorkflowGraphNode => {
  const id = nodeId(call.kind, call.name, call.counter)
  const schemas = options.schemas.get(id)
  const metadata: WorkflowGraphNodeMetadata = {
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
    readonly steps: ReadonlyMap<string, WorkflowGraphNodeMetadata>
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
  const steps = new Map<string, WorkflowGraphNodeMetadata>()
  const schemas = new Map<string, WorkflowGraphNodeSchemas>()
  const signalCounts = new Map<string, number>()
  const diagnostics: string[] = []
  const input = options.input ?? sampleValueForSchema(workflow.input) as I

  try {
    await workflow.executeInMemory(input, {
      executionId: `graph-${workflow.name}-${workflow.version}`,
      determinism,
      onEvent: (event) => {
        events.push(event)
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
