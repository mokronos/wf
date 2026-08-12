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
import { executorIntegrationInvoker } from "@mokronos/wfkit-executor"
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
// needs, and its modification time shows which files changed recently. It
// deliberately does not load the sources, so listing never runs module code.
const defaultPageSize = 10
const defaultDiagnosticLimit = 5
const defaultDiagnosticDetailLimit = 160

const verboseFlag = () => Flag.boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription("Show complete details")
)

const printMoreHint = (shown: number, total: number): void => {
  if (shown < total) console.log(`Showing ${shown} of ${total}. Rerun with --verbose for all.`)
}

const printWorkflows = (
  catalog: WorkflowCatalog,
  workflows: ReadonlyArray<WorkflowArtifact>,
  verbose: boolean
) => {
  if (workflows.length === 0) {
    console.log(`No workflows found in ${catalog.directory}`)
    return
  }

  const visible = verbose ? workflows : workflows.slice(0, defaultPageSize)
  for (const workflow of visible) {
    console.log(
      verbose
        ? `${workflow.id}\tupdated ${workflow.updatedAt ?? "unknown"}\t${workflow.source.length} bytes\t${catalog.pathFor(workflow.id)}`
        : `${workflow.id}\tupdated ${workflow.updatedAt ?? "unknown"}\t${catalog.pathFor(workflow.id)}`
    )
  }
  printMoreHint(visible.length, workflows.length)
}

const printRuns = (runs: ReadonlyArray<WorkflowRunRecord>, verbose: boolean) => {
  if (runs.length === 0) {
    console.log("No workflow runs found.")
    return
  }

  const visible = verbose ? runs : runs.slice(0, defaultPageSize)
  for (const run of visible) {
    const finishedAt = run.finishedAt ?? "-"
    console.log(
      verbose
        ? `${run.id}\t${run.status}\t${run.workflowId}\t${run.startedAt}\t${finishedAt}`
        : `${run.id}\t${run.status}\t${run.workflowId}`
    )
  }
  printMoreHint(visible.length, runs.length)
}

const printRunEvents = (events: ReadonlyArray<WorkflowHistoryRecord>, verbose: boolean) => {
  if (events.length === 0) {
    console.log("No workflow run events found.")
    return
  }

  const visible = verbose ? events : events.slice(-defaultPageSize)
  for (const event of visible) {
    console.log(
      verbose
        ? `${event.sequence}\t${event.createdAt}\t${event.event.type}\t${stringifyEventValue(event.event)}`
        : `${event.sequence}\t${event.createdAt}\t${event.event.type}`
    )
  }
  if (visible.length < events.length) {
    console.log(`Showing latest ${visible.length} of ${events.length}. Rerun with --verbose for full events.`)
  }
}

const writeStdoutLine = (text: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(`${text}\n`, (error) => {
      if (error === undefined || error === null) resolve()
      else reject(error)
    })
  })

const resultDisplayLimit = 800

const printRunResult = async (result: unknown, verbose: boolean): Promise<void> => {
  if (result === undefined) {
    await writeStdoutLine("Workflow completed.")
    return
  }

  const compact = JSON.stringify(result)
  if (verbose) {
    await writeStdoutLine(JSON.stringify(result, null, 2))
    return
  }
  if (compact.length <= resultDisplayLimit) {
    await writeStdoutLine(compact)
    return
  }
  await writeStdoutLine(JSON.stringify({
    truncated: true,
    characters: compact.length,
    preview: compact.slice(0, resultDisplayLimit),
    next: "Rerun with --verbose for the complete result."
  }))
}

const samplePayloadFor = (signal: PendingSignal): unknown =>
  signal.payloadSchema === undefined ? {} : sampleValueForJsonSchema(signal.payloadSchema)

const describePendingSignal = (runId: string, signal: PendingSignal, verbose: boolean): string => {
  const schemaLine = !verbose || signal.payloadSchema === undefined
    ? ""
    : `\n  expected payload schema: ${toJsonText(signal.payloadSchema)}`
  const sample = toJsonText(samplePayloadFor(signal))
  const payload = verbose || sample.length <= eventDetailLimit ? sample : "<json-payload>"
  return `Currently waiting for signal "${signal.name}".${schemaLine}\n  deliver with: wf signal ${runId} ${signal.name} '${payload}'`
}

const printPendingSignalHint = (
  runId: string,
  pendingSignals: ReadonlyArray<PendingSignal>,
  verbose: boolean
) => {
  const visibleSignals = verbose ? pendingSignals : pendingSignals.slice(0, defaultDiagnosticLimit)
  const names = visibleSignals
    .map((signal) => signal.timeout === undefined
      ? signal.name
      : `${signal.name} timeout=${stringifyEventValue(signal.timeout)}`)
    .join(", ")
  const remaining = pendingSignals.length - visibleSignals.length
  console.error(`${eventTag("signal")} ${yellow("waiting")} for ${bold(names)}${remaining > 0 ? ` (+${remaining} more)` : ""}`)
  const signal = pendingSignals[0]
  if (signal !== undefined) {
    if (verbose && signal.payloadSchema !== undefined) {
      console.error(`${eventTag("signal")} ${bold(signal.name)} expects payload schema: ${dim(toJsonText(signal.payloadSchema))}`)
    }
    const sample = toJsonText(samplePayloadFor(signal))
    const payload = verbose || sample.length <= eventDetailLimit ? sample : "<json-payload>"
    console.error(`${bold("Resume with:")} wf signal ${runId} ${signal.name} '${payload}'`)
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

const summarizeValue = (value: unknown, limit: number): string => {
  const serialized = stringifyEventValue(value)
  if (serialized.length <= limit) return serialized
  return `${serialized.slice(0, limit)}… (+${serialized.length - limit} chars)`
}

const summarizeEventValue = (value: unknown): string => summarizeValue(value, eventDetailLimit)

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

const printValidationResult = (
  result: Awaited<ReturnType<typeof workflowArtifactToGraph>>,
  verbose: boolean
) => {
  const graph = result.graph
  if (graph === undefined) {
    return
  }

  const exportName = result.exportName ?? "default"
  const nodes = graph.nodes.filter((node) => node.kind !== "start" && node.kind !== "end")
  console.log(`${green("Valid")} ${bold(result.artifact.id)}\t${bold(graph.workflowName)}#${exportName}\t${nodes.length} orchestration call${nodes.length === 1 ? "" : "s"}`)
  if (!verbose) {
    console.log("details: rerun with --verbose for schemas and traced flow")
    return
  }
  printSchemaLine("input", graph.schemas?.input)
  printSchemaLine("output", graph.schemas?.output)
  printSchemaLine("errors", graph.schemas?.errors)
  console.log(bold("flow:"))

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

const validationError = (
  result: Awaited<ReturnType<typeof workflowArtifactToGraph>>,
  verbose: boolean
): Error => {
  const traceDiagnostics = result.graph?.diagnostics ?? []
  const diagnostics = [...result.diagnostics, ...traceDiagnostics]
  const visible = verbose ? diagnostics : diagnostics.slice(0, defaultDiagnosticLimit)
  const more = visible.length < diagnostics.length
    ? `\n  - ${diagnostics.length - visible.length} more; rerun with --verbose for all diagnostics`
    : ""
  return new Error(`Invalid ${result.artifact.id}${visible.map((diagnostic) =>
    `\n  - ${verbose ? diagnostic : summarizeValue(diagnostic, defaultDiagnosticDetailLimit)}`
  ).join("")}${more}`)
}

const fileValidationArtifact = async (
  target: Extract<ValidateWorkflowTarget, { readonly kind: "file" }>
): Promise<WorkflowArtifact> => ({
  id: workflowIdFromFile(target.file),
  source: await readFile(target.file, "utf8"),
  createdAt: new Date().toISOString()
})

const catalogValidationArtifact = async (
  catalog: WorkflowCatalog,
  target: Extract<ValidateWorkflowTarget, { readonly kind: "catalog" }>
): Promise<WorkflowArtifact> => {
  const artifact = await catalog.get(target.id)
  if (artifact === undefined) {
    throw new Error(`Unknown workflow id: ${target.id}`)
  }
  return artifact
}

const withConsoleOutput = async <A>(verbose: boolean, task: () => Promise<A>): Promise<A> => {
  const log = console.log
  const info = console.info
  const warn = console.warn
  const error = console.error
  const debug = console.debug
  const sink = verbose ? error : (): void => {}
  console.log = sink
  console.info = sink
  console.warn = sink
  console.error = sink
  console.debug = sink
  try {
    return await task()
  } finally {
    console.log = log
    console.info = info
    console.warn = warn
    console.error = error
    console.debug = debug
  }
}

const traceWorkflowArtifact = async (
  artifact: WorkflowArtifact,
  inputText: string | undefined,
  verbose: boolean
): Promise<Awaited<ReturnType<typeof workflowArtifactToGraph>>> =>
  withConsoleOutput(verbose, () =>
    workflowArtifactToGraph(
      artifact,
      inputText === undefined ? {} : { input: parseJsonInput(inputText) }
    )
  )

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

const errorDetail = (error: unknown, verbose: boolean): EventDetail => [
  "error",
  red(verbose ? stringifyEventValue(error) : summarizeEventValue(error))
]

const reasonDetails = (reason: string | undefined, verbose: boolean): ReadonlyArray<EventDetail> =>
  reason === undefined ? [] : [["reason", verbose ? stringifyEventValue(reason) : summarizeEventValue(reason)]]

const printWorkflowEvent = (event: WorkflowEvent, verbose: boolean) => {
  const detail = (value: unknown): string =>
    verbose ? stringifyEventValue(value) : summarizeEventValue(value)
  switch (event.type) {
    case "workflow.started":
      printEventLine("workflow", "started", event.workflowName, [
        ["input", detail(event.payload)]
      ])
      return

    case "workflow.completed":
      printEventLine("workflow", "completed", event.workflowName, [
        ["result", detail(event.result)]
      ])
      return

    case "workflow.failed":
      printEventLine("workflow", "failed", event.workflowName, [errorDetail(event.error, verbose)])
      return

    case "step.started":
      printEventLine("step", "started", event.activityName, [["attempt", String(event.attempt)]])
      return

    case "step.completed":
      printEventLine("step", "completed", event.activityName, [
        ["attempt", String(event.attempt)],
        ["result", detail(event.result)]
      ])
      return

    case "step.failed":
      printEventLine("step", "failed", event.activityName, [errorDetail(event.error, verbose)])
      return

    case "compensation.started":
      printEventLine("compensation", "started", event.activityName, [
        ["reason", detail(event.reason)]
      ])
      return

    case "compensation.completed":
      printEventLine("compensation", "completed", event.activityName)
      return

    case "compensation.failed":
      printEventLine("compensation", "failed", event.activityName, [errorDetail(event.error, verbose)])
      return

    case "sleep.started":
      printEventLine("sleep", "started", event.activityName, [
        ["duration", detail(event.duration)]
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
        ["payload", detail(event.payload)]
      ])
      return

    case "signal.timeout":
      printEventLine("signal", "timeout", event.activityName, [
        ["timeout", detail(event.timeout)]
      ])
      return

    case "code.started":
      printEventLine("code", "started", event.activityName, reasonDetails(event.reason, verbose))
      return

    case "code.completed":
      printEventLine("code", "completed", event.activityName, [
        ...reasonDetails(event.reason, verbose),
        ["result", detail(event.result)]
      ])
      return

    case "code.failed":
      printEventLine("code", "failed", event.activityName, [
        ...reasonDetails(event.reason, verbose),
        errorDetail(event.error, verbose)
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
        errorDetail(event.error, verbose)
      ])
      return
  }
}

const awaitAndPrintRun = async (options: {
  readonly client: WorkflowClient
  readonly runId: string
  readonly historyLength: number
  readonly verbose: boolean
}) => {
  const outcome = await withConsoleOutput(
    options.verbose,
    () => options.client.observe(options.runId)
  )
  const records = (await options.client.history(options.runId))
    .filter((record) => record.sequence > options.historyLength)
  if (options.verbose) {
    for (const record of records) {
      if (isPrintableWorkflowEvent(record.event)) {
        printWorkflowEvent(record.event, true)
      }
    }
  }

  if (outcome.type === "signal-suspended") {
    printPendingSignalHint(options.runId, outcome.pendingSignals, options.verbose)
    return
  }

  if (outcome.result.type === "completed") {
    printEventLine("run", "completed", options.runId)
    await printRunResult(outcome.result.value, options.verbose)
    return
  }

  throw outcome.result.error
}

const engineDatabasePath = (storageDir: string) => path.join(storageDir, "engine.sqlite")

const createEngineBackedClient = (storageDir: string) => {
  const runtime = createWorkflowRuntime({
    backend: "sqlite",
    databasePath: engineDatabasePath(storageDir),
    integrations: executorIntegrationInvoker
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

const legacyMigrations = new Map<string, Promise<ReadonlyArray<string>>>()

const migrateOnce = async (storageDir: string, verbose: boolean): Promise<void> => {
  const pending = legacyMigrations.get(storageDir) ?? migrateLegacyCatalog(storageDir)
  legacyMigrations.set(storageDir, pending)
  const ids = await pending
  if (ids.length > 0) {
    console.error(
      `Moved ${ids.length} workflow(s) out of wf.sqlite into ${workflowsPath(storageDir)}${verbose ? `: ${ids.join(", ")}` : "."}`
    )
  }
}

/**
 * Opening the catalog is also where a pre-file `wf.sqlite` gets unpacked, once.
 * Commands that never look at workflows — help, integrations — leave storage
 * untouched, which is what keeps `wf --help` a read-only act.
 */
const openCatalog = async (runtime: CliRuntimeOptions, verbose: boolean): Promise<WorkflowCatalog> => {
  await migrateOnce(runtime.storageDir, verbose)
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
    ),
    verbose: verboseFlag()
  },
  ({ id, name, source, file, force, verbose }) => runCliTask(async () => {
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
    const catalog = await openCatalog(runtime, verbose)
    const existingWorkflow = await catalog.get(workflowId)
    if (existingWorkflow !== undefined && !options.force) {
      throw new Error(
        `Workflow id already exists: ${workflowId} (${catalog.pathFor(workflowId)}). Edit that file, or use --force to replace it.`
      )
    }

    // Load before writing so a broken source never lands in the catalog. This
    // also reports the workflow's real name, which lives in the source rather
    // than beside it.
    const loaded = await withConsoleOutput(
      verbose,
      () => loadWorkflowArtifact({ id: workflowId, source: sourceText })
    )
    const written = await catalog.write(workflowId, sourceText)
    console.log(verbose
      ? `Created ${written.id}\t${loaded.workflow.name}#${loaded.exportName}\t${catalog.pathFor(workflowId)}`
      : `Created ${written.id}\t${catalog.pathFor(workflowId)}`)
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
    ),
    verbose: verboseFlag()
  },
  ({ id, file, input, json, verbose }) => runCliTask(async () => {
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
    const artifact = target.kind === "catalog"
      ? await catalogValidationArtifact(await openCatalog(runtime, verbose), target)
      : await fileValidationArtifact(target)
    const result = await traceWorkflowArtifact(artifact, inputText, verbose)
    const invalid = result.diagnostics.length > 0 ||
      result.graph === undefined ||
      result.graph.diagnostics.length > 0
    if (json) {
      console.log(toJsonText(result))
      if (invalid) process.exitCode = 1
      return
    }
    if (invalid) throw validationError(result, verbose)
    printValidationResult(result, verbose)
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
  { verbose: verboseFlag() },
  ({ verbose }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime, verbose)
    printWorkflows(catalog, await catalog.list(), verbose)
  })
).pipe(Command.withDescription("List workflow files in the local catalog"))

const runsCommand = (runtime: CliRuntimeOptions) => Command.make(
  "runs",
  { verbose: verboseFlag() },
  ({ verbose }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime, verbose)
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      printRuns(await lifecycleRunRecords(client, await catalog.list()), verbose)
    } finally {
      await client.dispose()
    }
  })
).pipe(Command.withDescription("List persisted workflow runs"))

const historyCommand = (runtime: CliRuntimeOptions) => Command.make(
  "history",
  { runId: Argument.string("run-id"), verbose: verboseFlag() },
  ({ runId, verbose }) => runCliTask(async () => {
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      printRunEvents(await client.history(runId), verbose)
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
    input: Argument.string("json-input").pipe(Argument.optional),
    verbose: verboseFlag()
  },
  ({ id, input, verbose }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime, verbose)
    const artifact = await catalog.get(id)
    if (artifact === undefined) throw new Error(`Unknown workflow id: ${id}`)
    const loaded = await withConsoleOutput(verbose, () => loadWorkflowArtifact(artifact))
    // Snapshot before starting: from here on this run replays the source as it
    // is right now, however the catalog file changes afterwards.
    const sourceHash = await sourceStoreFor(runtime).save(artifact.source)
    const { client } = createEngineBackedClient(runtime.storageDir)
    try {
      const handle = await withConsoleOutput(verbose, () => client.start(
        loaded.workflow,
        parseJsonInput(Option.getOrUndefined(input)),
        { artifactId: artifact.id, sourceHash }
      ))
      console.error(`${eventTag("run")} id ${bold(handle.executionId)}`)
      await awaitAndPrintRun({ client, runId: handle.executionId, historyLength: 1, verbose })
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
    ),
    verbose: verboseFlag()
  },
  ({ runId, signalName, payload, actor, verbose }) => runCliTask(async () => {
    const catalog = await openCatalog(runtime, verbose)
    const sources = sourceStoreFor(runtime)
    const { runtime: engine, client } = createEngineBackedClient(runtime.storageDir)
    try {
      const execution = await client.execution(runId)
      const artifact = await artifactForExecution(catalog, sources, execution, runId)
      const loaded = await withConsoleOutput(verbose, () => loadWorkflowArtifact(artifact))
      engine.register([loaded.workflow])
      const historyLength = (await client.history(runId)).length
      try {
        await withConsoleOutput(verbose, () => client.signal(
          runId,
          signalName,
          parseJsonInput(Option.getOrUndefined(payload)),
          Option.match(actor, {
            onNone: () => ({}),
            onSome: (value) => ({ actor: value })
          })
        ))
        await awaitAndPrintRun({ client, runId, historyLength, verbose })
      } catch (error) {
        const pendingSignals = await client.pendingSignals(runId).catch(() => [])
        if (pendingSignals.length === 0) throw error
        const visibleSignals = verbose
          ? pendingSignals
          : pendingSignals.slice(0, defaultDiagnosticLimit)
        const lines = visibleSignals.map((pending) => describePendingSignal(runId, pending, verbose))
        if (visibleSignals.length < pendingSignals.length) {
          lines.push(`${pendingSignals.length - visibleSignals.length} more pending signals; rerun with --verbose for all.`)
        }
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
