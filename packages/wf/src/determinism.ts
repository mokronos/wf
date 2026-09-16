import { Schema } from "effect"
import type { WorkflowGraphNodeMetadata, WorkflowGraphNodeSchemas } from "./schemas.ts"

export const OrchestrationKind = Schema.Literals([
  "step",
  "sleep",
  "signal",
  "now",
  "random",
  "code",
  "all"
])
export type OrchestrationKind = typeof OrchestrationKind.Type

export const OrchestrationCall = Schema.Struct({
  kind: OrchestrationKind,
  name: Schema.String,
  counter: Schema.Number,
  branches: Schema.optionalKey(Schema.Number)
})
export type OrchestrationCall = typeof OrchestrationCall.Type

export class NonDeterminismError extends Schema.TaggedError<NonDeterminismError>()(
  "NonDeterminismError",
  {
    expected: OrchestrationCall,
    actual: OrchestrationCall
  }
) {
  override get message(): string {
    return `Non-deterministic workflow replay: expected ${formatCall(this.expected)} but saw ${formatCall(this.actual)}`
  }
}

export interface InMemoryDeterminismState {
  readonly calls: OrchestrationCall[]
  readonly blocks: Array<{
    readonly call: OrchestrationCall
    readonly branches: ReadonlyArray<ReadonlyArray<OrchestrationCall>>
  }>
  readonly values: Map<string, unknown>
  readonly nodeInspection: Map<OrchestrationCall, {
    readonly metadata: WorkflowGraphNodeMetadata
    readonly schemas: WorkflowGraphNodeSchemas
  }>
}

export const createInMemoryDeterminismState = (): InMemoryDeterminismState => ({
  calls: [],
  blocks: [],
  values: new Map(),
  nodeInspection: new Map()
})

export const formatCall = (call: OrchestrationCall): string =>
  `${call.kind}:${call.name}#${call.counter}${call.branches === undefined ? "" : ` branches=${call.branches}`}`

export const orchestrationCallsEqual = (
  left: OrchestrationCall,
  right: OrchestrationCall
): boolean =>
  left.kind === right.kind &&
  left.name === right.name &&
  left.counter === right.counter &&
  left.branches === right.branches

export const orchestrationValueKey = (call: OrchestrationCall): string => formatCall(call)
