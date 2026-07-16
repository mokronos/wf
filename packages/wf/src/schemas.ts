import { Schema } from "effect"

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"))
export type ExecutionId = typeof ExecutionId.Type

const OptionalString = Schema.optionalKey(Schema.String)
const OptionalUnknown = Schema.optionalKey(Schema.Unknown)

const JsonSchemaType = Schema.Union([Schema.String, Schema.Array(Schema.String)])

export interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>
  readonly const?: Schema.Json
  readonly enum?: ReadonlyArray<Schema.Json>
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly oneOf?: ReadonlyArray<JsonSchema>
  readonly items?: JsonSchema
  readonly properties?: { readonly [key: string]: JsonSchema }
  readonly required?: ReadonlyArray<string>
  readonly [key: string]: Schema.Json | JsonSchema | ReadonlyArray<Schema.Json> | ReadonlyArray<JsonSchema> | { readonly [key: string]: JsonSchema } | undefined
}

export const JsonSchema: Schema.Codec<JsonSchema> = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(JsonSchemaType),
    const: Schema.optionalKey(Schema.Json),
    enum: Schema.optionalKey(Schema.Array(Schema.Json)),
    anyOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    oneOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    items: Schema.optionalKey(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema)),
    properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    required: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export const decodeJsonSchema = (value: unknown): JsonSchema =>
  Schema.decodeUnknownSync(JsonSchema)(value)

/** Best-effort JSON Schema for an Effect schema; undefined when the schema
 *  has no JSON representation. */
export const jsonSchemaOf = (schema: unknown): JsonSchema | undefined => {
  try {
    const document = Schema.toJsonSchemaDocument(schema as never) as { readonly schema?: unknown }
    return document.schema === undefined ? undefined : decodeJsonSchema(document.schema)
  } catch {
    return undefined
  }
}

const WorkflowStartedEvent = Schema.Struct({
  type: Schema.Literal("workflow.started"),
  workflowName: Schema.String,
  payload: OptionalUnknown
})

const WorkflowCompletedEvent = Schema.Struct({
  type: Schema.Literal("workflow.completed"),
  workflowName: Schema.String,
  result: OptionalUnknown
})

const WorkflowFailedEvent = Schema.Struct({
  type: Schema.Literal("workflow.failed"),
  workflowName: Schema.String,
  error: OptionalUnknown
})

const StepStartedEvent = Schema.Struct({
  type: Schema.Literal("step.started"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  attempt: Schema.Number,
  input: OptionalUnknown
})

const StepCompletedEvent = Schema.Struct({
  type: Schema.Literal("step.completed"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  attempt: Schema.Number,
  result: OptionalUnknown
})

const StepFailedEvent = Schema.Struct({
  type: Schema.Literal("step.failed"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  error: OptionalUnknown
})

const CompensationStartedEvent = Schema.Struct({
  type: Schema.Literal("compensation.started"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  result: OptionalUnknown,
  input: OptionalUnknown,
  reason: OptionalUnknown
})

const CompensationCompletedEvent = Schema.Struct({
  type: Schema.Literal("compensation.completed"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String
})

const CompensationFailedEvent = Schema.Struct({
  type: Schema.Literal("compensation.failed"),
  executionId: ExecutionId,
  stepName: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  error: OptionalUnknown
})

const SleepStartedEvent = Schema.Struct({
  type: Schema.Literal("sleep.started"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  duration: OptionalUnknown
})

const SleepCompletedEvent = Schema.Struct({
  type: Schema.Literal("sleep.completed"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  duration: OptionalUnknown
})

const SignalWaitingEvent = Schema.Struct({
  type: Schema.Literal("signal.waiting"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  timeout: OptionalUnknown,
  /** JSON Schema of the payload the wait expects; lets a human or agent see
   *  what to send before delivering the signal. */
  payloadSchema: Schema.optionalKey(JsonSchema)
})

const SignalReceivedEvent = Schema.Struct({
  type: Schema.Literal("signal.received"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  payload: OptionalUnknown
})

const SignalTimeoutEvent = Schema.Struct({
  type: Schema.Literal("signal.timeout"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  timeout: OptionalUnknown
})

const CodeStartedEvent = Schema.Struct({
  type: Schema.Literal("code.started"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  reason: OptionalString
})

const CodeCompletedEvent = Schema.Struct({
  type: Schema.Literal("code.completed"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  reason: OptionalString,
  result: OptionalUnknown
})

const CodeFailedEvent = Schema.Struct({
  type: Schema.Literal("code.failed"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  reason: OptionalString,
  error: OptionalUnknown
})

const AllStartedEvent = Schema.Struct({
  type: Schema.Literal("all.started"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  branches: Schema.Number
})

const AllCompletedEvent = Schema.Struct({
  type: Schema.Literal("all.completed"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  branches: Schema.Number
})

const AllFailedEvent = Schema.Struct({
  type: Schema.Literal("all.failed"),
  executionId: ExecutionId,
  name: Schema.String,
  invocation: Schema.Number,
  activityName: Schema.String,
  branches: Schema.Number,
  error: OptionalUnknown
})

const CancellationReceivedEvent = Schema.Struct({
  type: Schema.Literal("cancellation.received"),
  executionId: ExecutionId,
  compensate: Schema.Boolean,
  actor: OptionalString
})

export const WorkflowEvent = Schema.Union([
  WorkflowStartedEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  StepFailedEvent,
  CompensationStartedEvent,
  CompensationCompletedEvent,
  CompensationFailedEvent,
  SleepStartedEvent,
  SleepCompletedEvent,
  SignalWaitingEvent,
  SignalReceivedEvent,
  SignalTimeoutEvent,
  CodeStartedEvent,
  CodeCompletedEvent,
  CodeFailedEvent,
  AllStartedEvent,
  AllCompletedEvent,
  AllFailedEvent,
  CancellationReceivedEvent
])
export type WorkflowEvent = typeof WorkflowEvent.Type
export const isWorkflowEvent = Schema.is(WorkflowEvent)

export const HistoryExecutionStarted = Schema.Struct({
  type: Schema.Literal("execution.started"),
  executionId: ExecutionId,
  workflowName: Schema.String,
  version: Schema.Number,
  payload: OptionalUnknown,
  actor: OptionalString
})

export const HistorySignalDelivered = Schema.Struct({
  type: Schema.Literal("signal.delivered"),
  executionId: ExecutionId,
  name: Schema.String,
  payload: OptionalUnknown,
  actor: OptionalString
})

export const HistoryExecutionCancelled = Schema.Struct({
  type: Schema.Literal("execution.cancelled"),
  executionId: ExecutionId,
  compensate: Schema.Boolean,
  actor: OptionalString
})

export const WorkflowHistoryEvent = Schema.Union([
  WorkflowEvent,
  HistoryExecutionStarted,
  HistorySignalDelivered,
  HistoryExecutionCancelled
])
export type WorkflowHistoryEvent = typeof WorkflowHistoryEvent.Type

export const WorkflowRunStatus = Schema.Literals(["running", "completed", "failed"])
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type

export const WorkflowArtifact = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  source: Schema.String,
  exportName: OptionalString,
  createdAt: OptionalString
})
export type WorkflowArtifact = typeof WorkflowArtifact.Type

export const WorkflowManifestEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  source: OptionalString,
  entrypoint: OptionalString,
  exportName: OptionalString,
  createdAt: OptionalString
})
export type WorkflowManifestEntry = typeof WorkflowManifestEntry.Type

export const WorkflowManifest = Schema.Struct({
  workflows: Schema.Array(WorkflowManifestEntry)
})
export type WorkflowManifest = typeof WorkflowManifest.Type

export const WorkflowRunRecord = Schema.Struct({
  id: ExecutionId,
  workflowId: Schema.String,
  workflowVersion: Schema.String,
  status: WorkflowRunStatus,
  input: Schema.Unknown,
  result: OptionalUnknown,
  error: OptionalUnknown,
  startedAt: Schema.String,
  finishedAt: OptionalString
})
export type WorkflowRunRecord = typeof WorkflowRunRecord.Type

export const WorkflowRunEventRecord = Schema.Struct({
  id: Schema.Number,
  runId: ExecutionId,
  sequence: Schema.Number,
  type: Schema.String,
  event: WorkflowHistoryEvent,
  createdAt: Schema.String
})
export type WorkflowRunEventRecord = typeof WorkflowRunEventRecord.Type

export const WorkflowGraphNodeKind = Schema.Literals([
  "step",
  "sleep",
  "signal",
  "now",
  "random",
  "code",
  "all",
  "start",
  "end",
  "error"
])
export type WorkflowGraphNodeKind = typeof WorkflowGraphNodeKind.Type

export const WorkflowGraphSchemas = Schema.Struct({
  input: Schema.optionalKey(JsonSchema),
  output: Schema.optionalKey(JsonSchema),
  errors: Schema.optionalKey(JsonSchema)
})
export type WorkflowGraphSchemas = typeof WorkflowGraphSchemas.Type

export const WorkflowGraphNodeSchemas = Schema.Struct({
  input: Schema.optionalKey(JsonSchema),
  output: Schema.optionalKey(JsonSchema),
  errors: Schema.optionalKey(JsonSchema),
  signal: Schema.optionalKey(JsonSchema)
})
export type WorkflowGraphNodeSchemas = typeof WorkflowGraphNodeSchemas.Type

export const WorkflowGraphNodeMetadata = Schema.Struct({
  activityName: OptionalString,
  input: OptionalUnknown,
  duration: OptionalUnknown,
  timeout: OptionalUnknown,
  branches: Schema.optionalKey(Schema.Number),
  reason: OptionalString,
  retry: Schema.optionalKey(Schema.Struct({
    attempts: Schema.Number,
    backoff: Schema.Literals(["exponential", "none"])
  })),
  concurrency: Schema.optionalKey(Schema.Struct({
    limit: Schema.Number,
    keyed: Schema.Boolean
  })),
  compensates: Schema.optionalKey(Schema.Boolean)
})
export type WorkflowGraphNodeMetadata = typeof WorkflowGraphNodeMetadata.Type

export const WorkflowGraphNode = Schema.Struct({
  id: Schema.String,
  kind: WorkflowGraphNodeKind,
  label: Schema.String,
  invocation: Schema.optionalKey(Schema.Number),
  repeated: Schema.Boolean,
  description: OptionalString,
  schemas: Schema.optionalKey(WorkflowGraphNodeSchemas),
  metadata: WorkflowGraphNodeMetadata
})
export type WorkflowGraphNode = typeof WorkflowGraphNode.Type

export const WorkflowGraphEdge = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  target: Schema.String,
  label: OptionalString
})
export type WorkflowGraphEdge = typeof WorkflowGraphEdge.Type

export const WorkflowGraphCall = Schema.Struct({
  kind: WorkflowGraphNodeKind,
  name: Schema.String,
  counter: Schema.Number,
  branches: Schema.optionalKey(Schema.Number)
})

export const WorkflowGraph = Schema.Struct({
  workflowName: Schema.String,
  version: Schema.Number,
  engineName: OptionalString,
  sourceHash: OptionalString,
  schemas: Schema.optionalKey(WorkflowGraphSchemas),
  nodes: Schema.Array(WorkflowGraphNode),
  edges: Schema.Array(WorkflowGraphEdge),
  calls: Schema.Array(WorkflowGraphCall),
  diagnostics: Schema.Array(Schema.String)
})
export type WorkflowGraph = typeof WorkflowGraph.Type

export const WorkflowArtifactGraph = Schema.Struct({
  artifact: WorkflowArtifact,
  exportName: OptionalString,
  graph: Schema.optionalKey(WorkflowGraph),
  diagnostics: Schema.Array(Schema.String)
})
export type WorkflowArtifactGraph = typeof WorkflowArtifactGraph.Type

export const WorkflowsResponse = Schema.Struct({
  generatedAt: Schema.String,
  workflows: Schema.Array(WorkflowArtifactGraph),
  error: OptionalString
})
export type WorkflowsResponse = typeof WorkflowsResponse.Type

export const RunsResponse = Schema.Struct({
  generatedAt: Schema.String,
  runs: Schema.Array(WorkflowRunRecord),
  error: OptionalString
})
export type RunsResponse = typeof RunsResponse.Type

export const RunEventsResponse = Schema.Struct({
  generatedAt: Schema.String,
  run: WorkflowRunRecord,
  events: Schema.Array(WorkflowRunEventRecord),
  error: OptionalString
})
export type RunEventsResponse = typeof RunEventsResponse.Type

export const decodeWorkflowsResponse = (value: unknown): WorkflowsResponse =>
  Schema.decodeUnknownSync(WorkflowsResponse)(value)

export const decodeRunsResponse = (value: unknown): RunsResponse =>
  Schema.decodeUnknownSync(RunsResponse)(value)

export const decodeRunEventsResponse = (value: unknown): RunEventsResponse =>
  Schema.decodeUnknownSync(RunEventsResponse)(value)
