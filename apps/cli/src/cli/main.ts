#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Data, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  createDirectoryWorkflowCatalog,
  createWorkflowClient,
  createWorkflowRuntime,
  createWorkflowSourceStore,
  loadWorkflowArtifact,
  lifecycleRunRecords,
  parseWorkflowId,
  parseWorkflowSourceHash,
  sampleValueForJsonSchema,
  toJsonText,
  workflowArtifactToGraph
} from "@mokronos/wfkit"
import { makeIntegrationsCommand } from "./integrations.ts"
import { migrateLegacyCatalog } from "../migrate-catalog.ts"
import { sourcesPath, workflowsPath } from "../paths.ts"
import type {
  JsonSchema,
  PendingSignal,
  WorkflowArtifact,
  WorkflowCatalog,
  WorkflowClient,
  WorkflowEvent,
  WorkflowHistoryEvent,
  WorkflowHistoryRecord,
  WorkflowId,
  WorkflowRunRecord,
  WorkflowSourceStore,
  WorkflowGraphNodeKind,
  WorkflowGraphNodeMetadata
} from "@mokronos/wfkit"

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  // Typed workflow errors are plain objects; String() would print
  // "[object Object]".
  return typeof error === "object" && error !== null ? toJsonText(error) : String(error)
}

const parseJsonInput = (input: string | undefined): unknown => {
  if (input === undefined) {
    return {}
  }

  try {
    return JSON.parse(input)
  } catch (error) {
    throw new Error(`Invalid JSON input: ${formatError(error)}`)
  }
}

interface CreateWorkflowOptions {
  readonly id: WorkflowId
  readonly name: string
  readonly source: string
  readonly force: boolean
}

// Exactly one of "catalog" (validate a registered id) or "file" (validate a
// file that has not been imported yet) — modelled as a union so the command
// body has no impossible "neither was provided" branch to re-check.
type ValidateWorkflowTarget =
  | { readonly kind: "catalog"; readonly id: string }
  | { readonly kind: "file"; readonly file: string }

const workflowIdFromFile = (file: string): WorkflowId => {
  const basename = path.basename(file, path.extname(file))
  const id = basename.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return parseWorkflowId(/^[a-z][a-z0-9-]*$/.test(id) ? id : "workflow")
}

const assertWorkflowName = (name: string) => {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    throw new Error("Workflow name must be a valid PascalCase TypeScript identifier")
  }
}

const toPascalCase = (value: string): string =>
  value
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("")

const workflowTemplate = (options: CreateWorkflowOptions): string => `import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const printMessage = defineStep({
  name: "PrintMessage",
  input: t.struct({ message: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(input.message)
  }
})

export const ${options.name} = defineWorkflow({
  name: "${options.name}",
  input: t.struct({
    message: t.string
  }),
  output: t.void,
  run: function* (input, ctx) {
    yield* ctx.run(printMessage, {
      message: input.message.trim()
    })
  }
})
`

// Listing prints the file path because that is the address an editor or agent
// needs; it deliberately does not load the sources, so listing a catalog never
// runs workflow module code.
const printWorkflows = (catalog: WorkflowCatalog, workflows: ReadonlyArray<WorkflowArtifact>) => {
  if (workflows.length === 0) {
    console.log(`No workflows found in ${catalog.directory}`)
    return
  }

  for (const workflow of workflows) {
    console.log(
      `${workflow.id}\t${workflow.source.length} bytes\t${catalog.pathFor(workflow.id)}`
    )
  }
}

const printRuns = (runs: ReadonlyArray<WorkflowRunRecord>) => {
  if (runs.length === 0) {
    console.log("No workflow runs found.")
    return
  }

  for (const run of runs) {
    const finishedAt = run.finishedAt ?? "-"
    console.log(
      `${run.id}\t${run.status}\t${run.workflowId}\t${run.startedAt}\t${finishedAt}`
    )
  }
}

const printRunEvents = (events: ReadonlyArray<WorkflowHistoryRecord>) => {
  if (events.length === 0) {
    console.log("No workflow run events found.")
    return
  }

  for (const event of events) {
    console.log(
      `${event.sequence}\t${event.createdAt}\t${event.event.type}\t${stringifyEventValue(event.event)}`
    )
  }
}

const writeStdoutLine = (text: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error === undefined || error === null) resolve()
      else reject(error)
    })
  })

const printRunResult = async (result: unknown): Promise<void> => {
  if (result === undefined) {
    await writeStdoutLine("Workflow completed.")
    return
  }

  await writeStdoutLine(JSON.stringify(result, null, 2))
}

const samplePayloadFor = (signal: PendingSignal): unknown =>
  signal.payloadSchema === undefined ? {} : sampleValueForJsonSchema(signal.payloadSchema)

const describePendingSignal = (runId: string, signal: PendingSignal): string => {
  const schemaLine = signal.payloadSchema === undefined
    ? ""
    : `\n  expected payload schema: ${toJsonText(signal.payloadSchema)}`
  return `Currently waiting for signal "${signal.name}".${schemaLine}\n  deliver with: wf signal ${runId} ${signal.name} '${toJsonText(samplePayloadFor(signal))}'`
}

const printPendingSignalHint = (runId: string, pendingSignals: ReadonlyArray<PendingSignal>) => {
  const names = pendingSignals
    .map((signal) => signal.timeout === undefined
      ? signal.name
      : `${signal.name} timeout=${stringifyEventValue(signal.timeout)}`)
    .join(", ")
  console.error(`${eventTag("signal")} ${yellow("waiting")} for ${bold(names)}`)
  const signal = pendingSignals[0]
  if (signal !== undefined) {
    if (signal.payloadSchema !== undefined) {
      console.error(`${eventTag("signal")} ${bold(signal.name)} expects payload schema: ${dim(toJsonText(signal.payloadSchema))}`)
    }
    console.error(`${bold("Resume with:")} wf signal ${runId} ${signal.name} '${toJsonText(samplePayloadFor(signal))}'`)
  }
}

const isPrintableWorkflowEvent = (event: WorkflowHistoryEvent): event is WorkflowEvent => {
  switch (event.type) {
    case "workflow.started":
    case "workflow.completed":
    case "workflow.failed":
    case "step.started":
    case "step.completed":
    case "step.failed":
    case "compensation.started":
    case "compensation.completed":
    case "compensation.failed":
    case "sleep.started":
    case "sleep.completed":
    case "signal.waiting":
    case "signal.received":
    case "signal.timeout":
    case "code.started":
    case "code.completed":
    case "code.failed":
    case "all.started":
    case "all.completed":
    case "all.failed":
      return true
    default:
      return false
  }
}

const stringifyEventValue = (value: unknown): string => {
  if (value === undefined) {
    return "undefined"
  }

  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  try {
    return toJsonText(value)
  } catch {
    return String(value)
  }
}

const eventDetailLimit = 320

const summarizeEventValue = (value: unknown): string => {
  const serialized = stringifyEventValue(value)
  if (serialized.length <= eventDetailLimit) return serialized
  return `${serialized.slice(0, eventDetailLimit)}… (+${serialized.length - eventDetailLimit} chars)`
}

// Derived from the graph schema rather than restated, so widening a metadata
// field cannot silently drift from what this formatter accepts.
type ValidationMetadataValue = WorkflowGraphNodeMetadata[keyof WorkflowGraphNodeMetadata]

const validationDetail = (key: string, value: ValidationMetadataValue): ReadonlyArray<EventDetail> =>
  value === undefined ? [] : [[key, stringifyEventValue(value)]]

// Only the metadata that changes how a node behaves at runtime; the traced
// sample `input` is omitted because it is invented, not authored.
const validationMetadata = (
  kind: WorkflowGraphNodeKind,
  metadata: WorkflowGraphNodeMetadata
): ReadonlyArray<EventDetail> => {
  switch (kind) {
    case "step":
      return [
        ...validationDetail("activityName", metadata.activityName),
        ...validationDetail("retry", metadata.retry),
        ...validationDetail("concurrency", metadata.concurrency),
        ...validationDetail("compensates", metadata.compensates)
      ]
    case "sleep":
      return validationDetail("duration", metadata.duration)
    case "signal":
      return validationDetail("timeout", metadata.timeout)
    case "code":
      return validationDetail("reason", metadata.reason)
    case "all":
      return validationDetail("branches", metadata.branches)
    default:
      return []
  }
}

// A workflow without typed errors renders as JSON Schema `{"not":{}}` (never).
// Printing that in the success block reads like a defect, so drop the line.
const isNeverSchema = (schema: JsonSchema): boolean => toJsonText(schema) === `{"not":{}}`

const printSchemaLine = (label: string, schema: JsonSchema | undefined) => {
  if (schema === undefined || isNeverSchema(schema)) return
  console.log(`${dim(`${label}:`)} ${toJsonText(schema)}`)
}

const printValidationResult = (result: Awaited<ReturnType<typeof workflowArtifactToGraph>>) => {
  const graph = result.graph
  if (graph === undefined) {
    return
  }

  const exportName = result.exportName ?? "default"
  console.log(`${green("Valid")} ${bold(result.artifact.id)}\t${bold(graph.workflowName)}#${exportName}`)
  printSchemaLine("input", graph.schemas?.input)
  printSchemaLine("output", graph.schemas?.output)
  printSchemaLine("errors", graph.schemas?.errors)
  console.log(bold("flow:"))

  const nodes = graph.nodes.filter((node) => node.kind !== "start" && node.kind !== "end")
  if (nodes.length === 0) {
    console.log("  (no orchestration calls)")
    return
  }

  for (const node of nodes) {
    const metadata = validationMetadata(node.kind, node.metadata)
      .map(([key, value]) => ` ${dim(`${key}=`)}${value}`)
      .join("")
    console.log(`  ${bold(node.kind)}\t${node.label}${metadata}${node.repeated ? " (repeated)" : ""}`)
  }
}

const validationError = (result: Awaited<ReturnType<typeof workflowArtifactToGraph>>): Error => {
  const traceDiagnostics = result.graph?.diagnostics ?? []
  const diagnostics = [...result.diagnostics, ...traceDiagnostics]
  return new Error(`Invalid ${result.artifact.id}${diagnostics.map((diagnostic) => `\n  - ${diagnostic}`).join("")}`)
}

const validationArtifact = async (
  catalog: WorkflowCatalog,
  target: ValidateWorkflowTarget
): Promise<WorkflowArtifact> => {
  if (target.kind === "file") {
    return {
      id: workflowIdFromFile(target.file),
      source: await readFile(target.file, "utf8"),
      createdAt: new Date().toISOString()
    }
  }

  const artifact = await catalog.get(target.id)
  if (artifact === undefined) {
    throw new Error(`Unknown workflow id: ${target.id}`)
  }
  return artifact
}

const traceWorkflowArtifact = async (
  artifact: WorkflowArtifact,
  inputText: string | undefined
): Promise<Awaited<ReturnType<typeof workflowArtifactToGraph>>> => {
  const log = console.log
  const info = console.info
  const warn = console.warn
  const error = console.error
  const debug = console.debug
  const suppress = (): void => {}
  console.log = suppress
  console.info = suppress
  console.warn = suppress
  console.error = suppress
  console.debug = suppress
  try {
    return await workflowArtifactToGraph(
      artifact,
      inputText === undefined ? {} : { input: parseJsonInput(inputText) }
    )
  } finally {
    console.log = log
    console.info = info
    console.warn = warn
    console.error = error
    console.debug = debug
  }
}

// --- colored event output ---------------------------------------------------
// Category tints the [tag], the verb carries the outcome (green/red/yellow),
// detail keys are dimmed. Colors turn off for non-TTY stderr, NO_COLOR, or
// TERM=dumb, so piped output stays plain text.

const colorEnabled = process.stderr.isTTY === true &&
  process.env["NO_COLOR"] === undefined &&
  process.env["TERM"] !== "dumb"

const paint = (code: string) => (text: string): string =>
  colorEnabled ? `\u001B[${code}m${text}\u001B[0m` : text

const dim = paint("2")
const bold = paint("1")
const red = paint("31")
const green = paint("32")
const yellow = paint("33")

type EventCategory = "run" | "workflow" | "step" | "code" | "sleep" | "signal" | "compensation" | "all"

const categoryPaint: Record<EventCategory, (text: string) => string> = {
  run: paint("1;32"),
  workflow: paint("1;35"),
  step: paint("1;34"),
  code: paint("1;36"),
  sleep: paint("1;90"),
  signal: paint("1;33"),
  compensation: paint("1;31"),
  all: paint("1;94")
}

const eventTag = (category: EventCategory): string => categoryPaint[category](`[${category}]`)

const paintVerb = (verb: string): string => {
  switch (verb) {
    case "completed":
    case "received":
      return green(verb)
    case "failed":
    case "timeout":
      return red(verb)
    case "waiting":
      return yellow(verb)
    default:
      return verb
  }
}

type EventDetail = readonly [key: string, value: string]

const printEventLine = (
  category: EventCategory,
  verb: string,
  subject: string,
  details: ReadonlyArray<EventDetail> = []
) => {
  const detailText = details.map(([key, value]) => ` ${dim(`${key}=`)}${value}`).join("")
  console.error(`${eventTag(category)} ${paintVerb(verb)} ${bold(subject)}${detailText}`)
}

const errorDetail = (error: unknown): EventDetail => ["error", red(summarizeEventValue(error))]

const reasonDetails = (reason: string | undefined): ReadonlyArray<EventDetail> =>
  reason === undefined ? [] : [["reason", summarizeEventValue(reason)]]

const printWorkflowEvent = (event: WorkflowEvent) => {
  switch (event.type) {
    case "workflow.started":
      printEventLine("workflow", "started", event.workflowName, [
        ["input", summarizeEventValue(event.payload)]
      ])
      return

    case "workflow.completed":
      printEventLine("workflow", "completed", event.workflowName, [
        ["result", summarizeEventValue(event.result)]
      ])
      return

    case "workflow.failed":
      printEventLine("workflow", "failed", event.workflowName, [errorDetail(event.error)])
      return

    case "step.started":
      printEventLine("step", "started", event.activityName, [["attempt", String(event.attempt)]])
      return

    case "step.completed":
      printEventLine("step", "completed", event.activityName, [
        ["attempt", String(event.attempt)],
        ["result", summarizeEventValue(event.result)]
      ])
      return

    case "step.failed":
      printEventLine("step", "failed", event.activityName, [errorDetail(event.error)])
      return

    case "compensation.started":
      printEventLine("compensation", "started", event.activityName, [
        ["reason", summarizeEventValue(event.reason)]
      ])
      return

    case "compensation.completed":
      printEventLine("compensation", "completed", event.activityName)
      return

    case "compensation.failed":
      printEventLine("compensation", "failed", event.activityName, [errorDetail(event.error)])
      return

    case "sleep.started":
      printEventLine("sleep", "started", event.activityName, [
        ["duration", summarizeEventValue(event.duration)]
      ])
      return

    case "sleep.completed":
      printEventLine("sleep", "completed", event.activityName)
      return

    case "signal.waiting":
      printEventLine("signal", "waiting", event.activityName)
      return

    case "signal.received":
      printEventLine("signal", "received", event.activityName, [
        ["payload", summarizeEventValue(event.payload)]
      ])
      return

    case "signal.timeout":
      printEventLine("signal", "timeout", event.activityName, [
        ["timeout", summarizeEventValue(event.timeout)]
      ])
      return

    case "code.started":
      printEventLine("code", "started", event.activityName, reasonDetails(event.reason))
      return

    case "code.completed":
      printEventLine("code", "completed", event.activityName, [
        ...reasonDetails(event.reason),
        ["result", summarizeEventValue(event.result)]
      ])
      return

    case "code.failed":
      printEventLine("code", "failed", event.activityName, [
        ...reasonDetails(event.reason),
        errorDetail(event.error)
      ])
      return

    case "all.started":
      printEventLine("all", "started", event.activityName, [["branches", String(event.branches)]])
      return

    case "all.completed":
      printEventLine("all", "completed", event.activityName, [["branches", String(event.branches)]])
      return

    case "all.failed":
      printEventLine("all", "failed", event.activityName, [
        ["branches", String(event.branches)],
        errorDetail(event.error)
      ])
      return
  }
}

const awaitAndPrintRun = async (options: {
  readonly client: WorkflowClient
  readonly runId: string
  readonly historyLength: number
}) => {
  const outcome = await options.client.observe(options.runId)
  const records = (await options.client.history(options.runId))
    .filter((record) => record.sequence > options.historyLength)
  for (const record of records) {
    if (isPrintableWorkflowEvent(record.event)) {
      printWorkflowEvent(record.event)
    }
  }

  if (outcome.type === "signal-suspended") {
    printPendingSignalHint(options.runId, outcome.pendingSignals)
    return
  }

  if (outcome.result.type === "completed") {
    await printRunResult(outcome.result.value)
    return
  }

  throw outcome.result.error
}

const engineDatabasePath = (storageDir: string) => path.join(storageDir, "engine.sqlite")

const createEngineBackedClient = (storageDir: string) => {
  const runtime = createWorkflowRuntime({
    backend: "sqlite",
    databasePath: engineDatabasePath(storageDir)
  })
  const client = createWorkflowClient(runtime)
  return { runtime, client }
}

export interface CliRuntimeOptions {
  readonly rootDir: string
  readonly storageDir: string
}

class WorkflowCliError extends Data.TaggedError("WorkflowCliError")<{
  readonly message: string
}> {}

const cliError = (error: unknown): WorkflowCliError =>
  new WorkflowCliError({ message: formatError(error) })

const runCliTask = <A>(task: () => Promise<A>): Effect.Effect<A, WorkflowCliError> =>
  Effect.tryPromise({ try: task, catch: cliError })

const legacyMigrations = new Map<string, Promise<void>>()

const migrateOnce = (storageDir: string): Promise<void> => {
  const pending = legacyMigrations.get(storageDir) ?? migrateLegacyCatalog(storageDir).then((ids) => {
    if (ids.length === 0) return
    console.error(
      `Moved ${ids.length} workflow(s) out of wf.sqlite into ${workflowsPath(storageDir)}: ${ids.join(", ")}`
    )
  })
  legacyMigrations.set(storageDir, pending)
  return pending
}

/**
 * Opening the catalog is also where a pre-file `wf.sqlite` gets unpacked, once.
 * Commands that never look at workflows — help, integrations — leave storage
 * untouched, which is what keeps `wf --help` a read-only act.
 */
const openCatalog = async (runtime: CliRuntimeOptions): Promise<WorkflowCatalog> => {
  await migrateOnce(runtime.storageDir)
  return createDirectoryWorkflowCatalog({ directory: workflowsPath(runtime.storageDir) })
}

const sourceStoreFor = (runtime: CliRuntimeOptions): WorkflowSourceStore =>
  createWorkflowSourceStore({ directory: sourcesPath(runtime.storageDir) })

/**
 * The source a run must replay: the snapshot it was pinned to at start, not the
 * catalog file, which may have been edited since. Runs recorded before snapshots
 * existed fall back to the catalog entry they came from.
 */
const artifactForExecution = async (
  catalog: WorkflowCatalog,
  sources: WorkflowSourceStore,
  execution: { readonly artifactId?: string; readonly sourceHash?: string; readonly workflowName: string },
  runId: string
): Promise<WorkflowArtifact> => {
  if (execution.sourceHash !== undefined) {
    const hash = parseWorkflowSourceHash(execution.sourceHash)
    const source = await sources.read(hash)
    if (source !== undefined) {
      return {
        id: parseWorkflowId(execution.artifactId ?? "snapshot"),
        source
      }
    }
  }

  const artifact = execution.artifactId === undefined
    ? undefined
    : await catalog.get(execution.artifactId)
  if (artifact === undefined) {
    throw new Error(`Workflow source was deleted for run ${runId}: ${execution.workflowName}`)
  }
  return artifact
}

const createCommand = (runtime: CliRuntimeOptions) => Command.make(
  "create",
  {
    id: Argument.string("workflow-id").pipe(
      Argument.withDescription("Lowercase workflow id")
    ),
    name: Flag.string("name").pipe(
      Flag.optional,
      Flag.withDescription("Name the workflow in a generated template")
    ),
    source: Flag.string("source").pipe(
      Flag.optional,
      Flag.withDescription("Import inline TypeScript source")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Import TypeScript from a file")
    ),
    force: Flag.boolean("force").pipe(
      Flag.withDescription("Replace an existing workflow id")
    )
  },
  ({ id, name, source, file, force }) => runCliTask(async () => {
    const workflowId = parseWorkflowId(id)
    const nameValue = Option.getOrUndefined(name)
    const sourceValue = Option.getOrUndefined(source)
    const fileValue = Option.getOrUndefined(file)
    if (sourceValue !== undefined && fileValue !== undefined) {
      throw new Error("Use either --source or --file, not both")
    }
    if (nameValue !== undefined) assertWorkflowName(nameValue)
    const options: CreateWorkflowOptions = {
      id: workflowId,
      name: nameValue ?? `${toPascalCase(workflowId)}Workflow`,
      source: "",
      force
    }
    const sourceText = sourceValue ??
      (fileValue === undefined
        ? workflowTemplate(options)
        : await readFile(fileValue, "utf8"))
    const catalog = await openCatalog(runtime)
    const existingWorkflow = await catalog.get(workflowId)
    if (existingWorkflow !== undefined && !options.force) {
      throw new Error(
        `Workflow id already exists: ${workflowId} (${catalog.pathFor(workflowId)}). Edit that file, or use --force to replace it.`
      )
    }

    // Load before writing so a broken source never lands in the catalog. This
    // also reports the workflow's real name, which lives in the source rather
    // than beside it.
    const loaded = await loadWorkflowArtifact({ id: workflowId, source: sourceText })
    const written = await catalog.write(workflowId, sourceText)
    console.log(
      `Created ${written.id}\t${loaded.workflow.name}#${loaded.exportName}\t${catalog.pathFor(workflowId)}`
    )
  })
).pipe(
  Command.withDescription("Create or import a workflow file into the local catalog"),
  Command.withExamples([
    { command: "wf create welcome-email" },
    { command: "wf create email --file workflows/email.ts" }
  ])
)

const validateCommand = (runtime: CliRuntimeOptions) => Command.make(
  "validate",
  {
    id: Argument.string("workflow-id").pipe(
      Argument.optional,
      Argument.withDescription("Registered workflow id")
    ),
    file: Flag.string("file").pipe(
      Flag.optional,
      Flag.withDescription("Validate a TypeScript workflow file outside the catalog")
    ),
    input: Flag.string("input").pipe(
      Flag.optional,
      Flag.withDescription("Use this JSON value while tracing the workflow")
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print the complete validation graph as JSON")
    )
  },
  ({ id, file, input, json }) => runCliTask(async () => {
    const idValue = Option.getOrUndefined(id)
    const fileValue = Option.getOrUndefined(file)
    if (idValue !== undefined && fileValue !== undefined) {
      throw new Error("Use either a workflow id or --file, not both")
    }
    const target: ValidateWorkflowTarget = idValue !== undefined
      ? { kind: "catalog", id: idValue }
      : fileValue !== undefined
        ? { kind: "file", file: fileValue }
        : (() => { throw new Error("wf validate requires a workflow id or --file") })()
    const inputText = Option.getOrUndefined(input)
    const artifact = await validationArtifact(await openCatalog(runtime), target)
    const result = await traceWorkflowArtifact(artifact, inputText)
    const invalid = result.diagnostics.length > 0 ||
      result.graph === undefined ||
      result.graph.diagnostics.length > 0
    if (json) {
      console.log(toJsonText(result))
      if (invalid) process.exitCode = 1
      return
    }
    if (invalid) throw validationError(result)
    printValidationResult(result)
  })
).pipe(
  Command.withDescription("Validate a workflow without starting a durable run"),
  Command.withExamples([
    { command: "wf validate welcome-email" },
    { command: "wf validate --file workflows/email.ts --json" }
  ])
)

const listCommand = (runtime: CliRuntimeOptions) => Command.make(
  "list",
  {},
  () => runCliTask(async () => {
    const catalog = await openCatalog(runtime)
    printWorkflows(catalog, await catalog.list())
  })
).pipe(Command.withDescription("List workflow files in the local catalog"))

const runsCommand = (runtime: CliRuntimeOptions) => Command.make(
  "runs",
  {},
  () => runCliTask(async () => {
    const catalog = await openCatalog(runtime)
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      printRuns(await lifecycleRunRecords(client, await catalog.list()))
    } finally {
      await client.dispose()
    }
  })
).pipe(Command.withDescription("List persisted workflow runs"))

const historyCommand = (runtime: CliRuntimeOptions) => Command.make(
  "history",
  { runId: Argument.string("run-id") },
  ({ runId }) => runCliTask(async () => {
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      printRunEvents(await client.history(runId))
    } finally {
      await client.dispose()
    }
  })
).pipe(
  Command.withAlias("events"),
  Command.withDescription("Show the persisted event history for a workflow run")
)

const runCommand = (runtime: CliRuntimeOptions) => Command.make(
  "run",
  {
    id: Argument.string("workflow-id"),
    input: Argument.string("json-input").pipe(Argument.optional)
  },
  ({ id, input }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime)
    const artifact = await catalog.get(id)
    if (artifact === undefined) throw new Error(`Unknown workflow id: ${id}`)
    const loaded = await loadWorkflowArtifact(artifact)
    // Snapshot before starting: from here on this run replays the source as it
    // is right now, however the catalog file changes afterwards.
    const sourceHash = await sourceStoreFor(runtime).save(artifact.source)
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      const handle = await client.start(loaded.workflow, parseJsonInput(Option.getOrUndefined(input)), {
        artifactId: artifact.id,
        sourceHash
      })
      console.error(`${eventTag("run")} id ${bold(handle.executionId)}`)
      await awaitAndPrintRun({ client, runId: handle.executionId, historyLength: 1 })
    } finally {
      await client.dispose()
    }
  })
).pipe(
  Command.withDescription("Start a registered workflow run"),
  Command.withExamples([
    { command: "wf run welcome-email" },
    { command: "wf run welcome-email '{\"message\":\"hello\"}'" }
  ])
)

const signalCommand = (runtime: CliRuntimeOptions) => Command.make(
  "signal",
  {
    runId: Argument.string("run-id"),
    signalName: Argument.string("signal-name"),
    payload: Argument.string("json-payload").pipe(Argument.optional),
    actor: Flag.string("actor").pipe(
      Flag.optional,
      Flag.withDescription("Record who delivered the signal")
    )
  },
  ({ runId, signalName, payload, actor }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime)
    const sources = sourceStoreFor(runtime)
    const { runtime: engine, client } = createEngineBackedClient(runtime.storageDir)
    try {
      const execution = await client.execution(runId)
      const artifact = await artifactForExecution(catalog, sources, execution, runId)
      const loaded = await loadWorkflowArtifact(artifact)
      engine.register([loaded.workflow])
      const historyLength = (await client.history(runId)).length
      try {
        await client.signal(
          runId,
          signalName,
          parseJsonInput(Option.getOrUndefined(payload)),
          Option.match(actor, {
            onNone: () => ({}),
            onSome: (value) => ({ actor: value })
          })
        )
        await awaitAndPrintRun({ client, runId, historyLength })
      } catch (error) {
        const pendingSignals = await client.pendingSignals(runId).catch(() => [])
        if (pendingSignals.length === 0) throw error
        const lines = pendingSignals.map((pending) => describePendingSignal(runId, pending))
        throw new Error(`${formatError(error)}\n${lines.join("\n")}`)
      }
    } finally {
      await client.dispose()
    }
  })
).pipe(Command.withDescription("Resume a run waiting for a signal"))

export const makeWorkflowCommands = (runtime: CliRuntimeOptions) => [
  createCommand(runtime),
  validateCommand(runtime),
  listCommand(runtime),
  runCommand(runtime),
  runsCommand(runtime),
  historyCommand(runtime),
  signalCommand(runtime),
  makeIntegrationsCommand({ storageDir: runtime.storageDir })
] as const
