import { whenPresent, whenPresentFields } from "../optional.ts"
import { Predicate } from "effect"
import type {
  DefinedWorkflow,
  InMemoryDeterminismState,
  InspectableStep,
  OrchestrationCall
} from "../core.ts"
import type { SecretResolver } from "../secrets.ts"
import type { IntegrationSource } from "../integration-contract.ts"
import { integrationSourceKey } from "../integration-contract.ts"
import { createInMemoryDeterminismState } from "../core.ts"
import { createSignalTransport } from "../signal.ts"
import type { WorkflowEvent } from "../events.ts"
import {
  jsonSchemaOf,
  type WorkflowArtifactGraph,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowGraphNodeKind,
  type WorkflowGraphNodeMetadata,
  type WorkflowGraphNodeSchemas,
  type WorkflowGraphSchemas
} from "../schemas.ts"
import type { WorkflowArtifact } from "./artifact.ts"
import { validateWorkflowArtifact } from "./loader.ts"
import { sampleValueForSchema } from "./sample.ts"
export { sampleValueForJsonSchema, sampleValueForSchema } from "./sample.ts"

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
    ...whenPresent("input", input),
    ...whenPresent("output", output),
    ...whenPresent("errors", errors)
  })
}

const stepSchemas = (step: InspectableStep): WorkflowGraphNodeSchemas | undefined => {
  const input = jsonSchemaFor(step.input)
  const output = jsonSchemaFor(step.output)
  const errors = jsonSchemaFor(step.errors)
  return objectWithOptionalSchemas({
    ...whenPresent("input", input),
    ...whenPresent("output", output),
    ...whenPresent("errors", errors)
  })
}

const describeStep = (step: InspectableStep): WorkflowGraphNodeMetadata => ({
  ...whenPresent("integration", step.kind === "integration" ? step.source : undefined),
  ...whenPresent("retry", step.retry),
  ...whenPresentFields(step.concurrency, (concurrency) => ({
    concurrency: { limit: concurrency.limit, keyed: concurrency.key !== undefined }
  })),
  compensates: step.compensate !== undefined
})

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
          ...whenPresent("reason", event.reason)
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
    ...whenPresent("branches", call.branches)
  }
  const description = Predicate.isString(metadata.reason)
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
    ...whenPresent("description", description),
    ...whenPresent("schemas", schemas),
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
    sourceHash: options.workflow.sourceHash,
    ...whenPresent("schemas", schemas),
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
  const input = options.input ?? workflow.input.make(sampleValueForSchema(workflow.input))

  try {
    await workflow.executeInMemory(input, {
      executionId: `graph-${workflow.name}`,
      determinism,
      signalTransport: createSignalTransport(),
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
        return { handled: true, value: sampleValueForSchema(step.output) }
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

/**
 * The distinct integrations a traced workflow needs, in first-use order.
 *
 * Deduplicated on the whole reference rather than the integration slug, so a
 * workflow that reads from `user` and writes to `org` reports both tiers — they
 * are two separate things to have connected.
 *
 * Only branches the trace actually walked are represented; a step behind an
 * untaken conditional will not appear. Pass a representative `input` to
 * `workflowToGraph` when a specific path matters.
 */
export const workflowGraphIntegrations = (
  graph: WorkflowGraph
): ReadonlyArray<IntegrationSource> => {
  const found = new Map<string, IntegrationSource>()
  for (const node of graph.nodes) {
    const reference = node.metadata.integration
    if (reference === undefined) continue
    const key = integrationSourceKey(reference)
    if (!found.has(key)) found.set(key, reference)
  }
  return [...found.values()]
}

export const workflowArtifactToGraph = async (
  artifact: WorkflowArtifact,
  options: WorkflowGraphOptions = {}
): Promise<WorkflowArtifactGraph> => {
  const validation = await validateWorkflowArtifact(artifact)
  if (!validation.valid) {
    return {
      artifact,
      diagnostics: validation.diagnostics
    }
  }
  return {
    artifact,
    exportName: validation.loaded.exportName,
    graph: await workflowToGraph(validation.loaded.workflow, options),
    diagnostics: validation.diagnostics
  }
}
