#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import {
  createWorkflowClient,
  createWorkflowRuntime,
  createSqliteWorkflowRepository,
  envSecretResolver,
  loadWorkflowArtifact,
  sampleValueForJsonSchema,
  toJsonText
} from "../index.ts"
import { discover, getIntegrationSurface, validateIntegrationNode } from "../sdk/integrations.ts"
import type {
  PendingSignal,
  WorkflowArtifact,
  WorkflowClient,
  WorkflowEvent,
  WorkflowHistoryEvent,
  WorkflowRepository,
  WorkflowRunEventRecord,
  WorkflowRunRecord
} from "../index.ts"

const help = `wf - create, run, and inspect durable TypeScript workflows

Usage:
  wf <command> [options]

Commands:
  create    Create or import a workflow
  list      List registered workflows
  run       Start a workflow run
  runs      List persisted runs
  history   Show the event history for a run
  signal    Resume a run waiting for a signal
  integrations  Discover and validate integration surfaces (integrations.sh)
  help      Show help for a command

Run "wf help <command>" for command-specific usage and examples.
`

const commandHelp = (command: string | undefined): string | undefined => {
  switch (command) {
    case "create":
      return `Create or import a workflow into the local catalog.

Usage:
  wf create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]

Options:
  --name <name>       Select a workflow export explicitly
  --source <source>   Import inline TypeScript source
  --file <path>       Import TypeScript from a file
  --version <value>   Set the workflow version (default: dev)
  --force             Replace an existing workflow id

Examples:
  wf create welcome-email
  wf create email --file workflows/email.ts --version 1
`
    case "list":
      return `List workflows registered in the local catalog.

Usage:
  wf list
`
    case "run":
      return `Start a registered workflow with optional JSON input.

Usage:
  wf run <workflow-id> [json-input]

Examples:
  wf run welcome-email
  wf run welcome-email '{"message":"hello"}'
`
    case "runs":
      return `List workflow runs persisted in the local catalog.

Usage:
  wf runs
`
    case "history":
    case "events":
      return `Show the persisted event history for a workflow run.

Usage:
  wf history <run-id>
`
    case "signal":
      return `Deliver a signal to a suspended workflow run.

Usage:
  wf signal <run-id> <signal-name> [json-payload] [--actor <actor>]

Options:
  --actor <actor>     Record who delivered the signal

Example:
  wf signal <run-id> approval '{"approved":true}' --actor ops
`
    case "help":
      return `Show top-level or command-specific help.

Usage:
  wf help [command]

Example:
  wf help create
`
    case "integrations":
      return `Discover and validate integration surfaces from integrations.sh.

Usage:
  wf integrations search <term> [--kind mcp|openapi|graphql|cli] [--limit <n>] [--json]
  wf integrations show <domain> [--json]
  wf integrations validate [<json>] [--file <path>] [--live] [--input <json>] [--json]
`
    case undefined:
      return help
    default:
      return undefined
  }
}

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

interface SignalCommandOptions {
  readonly runId: string
  readonly signalName: string
  readonly payload: unknown
  readonly actor?: string
}

const parseSignalCommandOptions = (args: ReadonlyArray<string>): SignalCommandOptions => {
  const [runId, signalName, ...rest] = args
  if (runId === undefined || signalName === undefined) {
    throw new Error("wf signal requires a run id and signal name")
  }

  let payloadText: string | undefined
  let actor: string | undefined

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!

    switch (arg) {
      case "--actor":
        actor = readFlagValue(rest, ++index, "--actor")
        break

      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown wf signal option: ${arg}`)
        }
        if (payloadText !== undefined) {
          throw new Error("wf signal accepts only one JSON payload")
        }
        payloadText = arg
        break
    }
  }

  return {
    runId,
    signalName,
    payload: parseJsonInput(payloadText),
    ...(actor === undefined ? {} : { actor })
  }
}

interface CreateWorkflowOptions {
  readonly id: string
  readonly name: string
  readonly nameProvided: boolean
  readonly source: string
  readonly version: string
  readonly force: boolean
}

interface RawCreateWorkflowOptions {
  readonly id: string
  readonly name: string
  readonly nameProvided: boolean
  readonly source?: string
  readonly sourceFile?: string
  readonly version: string
  readonly force: boolean
}

const parseCreateWorkflowOptions = (
  id: string | undefined,
  args: ReadonlyArray<string>
): RawCreateWorkflowOptions => {
  if (id === undefined) {
    throw new Error("wf create requires a workflow id")
  }

  assertWorkflowId(id)

  let name = `${toPascalCase(id)}Workflow`
  let nameProvided = false
  let source: string | undefined
  let sourceFile: string | undefined
  let version = "dev"
  let force = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]

    switch (arg) {
      case "--name":
        name = readFlagValue(args, ++index, "--name")
        assertWorkflowName(name)
        nameProvided = true
        break

      case "--source":
        source = readFlagValue(args, ++index, "--source")
        break

      case "--file":
        sourceFile = readFlagValue(args, ++index, "--file")
        break

      case "--version":
        version = readFlagValue(args, ++index, "--version")
        break

      case "--force":
        force = true
        break

      default:
        throw new Error(`Unknown wf create option: ${arg}`)
    }
  }

  if (source !== undefined && sourceFile !== undefined) {
    throw new Error("Use either --source or --file, not both")
  }

  return {
    id,
    name,
    nameProvided,
    ...(source === undefined ? {} : { source }),
    ...(sourceFile === undefined ? {} : { sourceFile }),
    version,
    force
  }
}

const parseCreateWorkflowOptionsWithSource = async (
  id: string | undefined,
  args: ReadonlyArray<string>
): Promise<CreateWorkflowOptions> => {
  const options = parseCreateWorkflowOptions(id, args)
  const source = options.source ??
    (options.sourceFile === undefined
      ? workflowTemplate({ ...options, source: "" })
      : await readFile(options.sourceFile, "utf8"))

  return {
    id: options.id,
    name: options.name,
    nameProvided: options.nameProvided,
    source,
    version: options.version,
    force: options.force
  }
}

const readFlagValue = (
  args: ReadonlyArray<string>,
  index: number,
  flag: string
): string => {
  const value = args[index]
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

const integrationJson = async (text: string): Promise<Schema.Schema.Type<typeof Schema.Json>> => {
  try {
    return await Schema.decodeUnknownPromise(Schema.Json)(JSON.parse(text))
  } catch (error) {
    throw new Error(`Invalid JSON input: ${formatError(error)}`)
  }
}

const printIntegrationSurface = (surface: Awaited<ReturnType<typeof getIntegrationSurface>>) => {
  console.log(surface.summary ?? surface.description ?? "No summary.")
  for (const entry of surface.surfaces ?? []) {
    console.log(`\n${entry.name ?? entry.slug ?? entry.type} (${entry.type})${entry.url === undefined ? "" : `\n${entry.url}`}`)
    if (entry.spec !== undefined) console.log(`spec: ${entry.spec}`)
    if (entry.docs !== undefined) console.log(`docs: ${entry.docs}`)
    if (entry.transports !== undefined) console.log(`transports: ${entry.transports.join(", ")}`)
    if (entry.auth !== undefined) {
      const uses = entry.auth.entries?.flatMap((authEntry) => authEntry.use ?? []) ?? []
      console.log(`auth: ${entry.auth.status ?? "unknown"}${uses.length === 0 ? "" : ` (${uses.map((use) => `${use.id}${use.mechanics?.headerName === undefined ? "" : `: ${use.mechanics.headerName}${use.mechanics.scheme === undefined ? "" : ` ${use.mechanics.scheme}`}`}`).join(", ")})`}`)
    }
    if ((entry.type === "mcp" || entry.type === "http") && entry.url !== undefined) {
      const mechanics = entry.auth?.entries?.[0]?.use?.[0]?.mechanics
      const credential = entry.auth?.entries?.[0]?.use?.[0]?.id
      console.log("integration({")
      console.log(`  source: { kind: \"${entry.type === "mcp" ? "mcp" : "openapi"}\", url: \"${entry.url}\" },`)
      console.log('  operation: "<tool name — list with a live validate or the server docs>",')
      if (entry.auth?.status === "required" && credential !== undefined) console.log(`  auth: { kind: "header", credential: auth("${credential.replace(/^auth:/, "")}"), header: "${mechanics?.headerName ?? "Authorization"}" },`)
      console.log("  input: t.struct({ ... }), output: t.struct({ ... })")
      console.log("})")
    }
  }
  if (surface.credentials !== undefined) {
    console.log("\nCredentials:")
    for (const [id, credential] of Object.entries(surface.credentials)) console.log(`${id}\t${credential.type ?? "unknown"}\t${credential.label ?? ""}\t${credential.generateUrl ?? ""}\t${credential.setup?.split("\n")[0] ?? ""}`)
  }
}

const runIntegrationsCommand = async (args: ReadonlyArray<string>): Promise<void> => {
  const [subcommand, ...rest] = args
  if (subcommand === "search") {
    const [term, ...flags] = rest
    if (term === undefined) throw new Error("wf integrations search requires a term")
    let kind: "mcp" | "openapi" | "graphql" | "cli" | undefined
    let limit: number | undefined
    let json = false
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index]
      if (flag === "--json") json = true
      else if (flag === "--kind") { const value = readFlagValue(flags, ++index, flag); if (value !== "mcp" && value !== "openapi" && value !== "graphql" && value !== "cli") throw new Error("--kind must be mcp, openapi, graphql, or cli"); kind = value }
      else if (flag === "--limit") { const value = Number(readFlagValue(flags, ++index, flag)); if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer"); limit = value }
      else throw new Error(`Unknown wf integrations search option: ${flag}`)
    }
    const result = await discover(term, { ...(kind === undefined ? {} : { kind }), ...(limit === undefined ? {} : { limit }) })
    if (json) console.log(JSON.stringify(result, null, 2))
    else { for (const entry of result.results) console.log(`${entry.domain}\t${entry.kinds.join(",")}\t${entry.description}`); console.log("run: wf integrations show <domain>") }
    return
  }
  if (subcommand === "show") {
    const [domain, ...flags] = rest
    if (domain === undefined) throw new Error("wf integrations show requires a domain")
    if (flags.length > 1 || (flags.length === 1 && flags[0] !== "--json")) throw new Error("wf integrations show accepts only --json")
    const surface = await getIntegrationSurface(domain)
    if (flags[0] === "--json") console.log(JSON.stringify(surface, null, 2)); else printIntegrationSurface(surface)
    return
  }
  if (subcommand === "validate") {
    let configText: string | undefined
    let file: string | undefined
    let inputText: string | undefined
    let live = false
    let json = false
    for (let index = 0; index < rest.length; index += 1) {
      const flag = rest[index]!
      if (flag === "--file") file = readFlagValue(rest, ++index, flag)
      else if (flag === "--input") inputText = readFlagValue(rest, ++index, flag)
      else if (flag === "--live") live = true
      else if (flag === "--json") json = true
      else if (flag.startsWith("--")) throw new Error(`Unknown wf integrations validate option: ${flag}`)
      else if (configText === undefined) configText = flag
      else throw new Error("wf integrations validate accepts only one JSON config")
    }
    if ((configText === undefined) === (file === undefined)) throw new Error("wf integrations validate requires exactly one of JSON config or --file")
    const config = await integrationJson(file === undefined ? configText! : await readFile(file, "utf8"))
    const report = await validateIntegrationNode(config, { live, ...(inputText === undefined ? {} : { sampleInput: await integrationJson(inputText) }) })
    if (json) console.log(JSON.stringify(report, null, 2)); else for (const entry of report.findings) console.log(`${entry.severity}\t${entry.check}\t${entry.message}`)
    if (!report.ok) throw new Error("integration validation failed")
    return
  }
  throw new Error(`Unknown wf integrations command: ${subcommand ?? ""}`)
}

const assertWorkflowId = (id: string) => {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("Workflow id must start with a lowercase letter and contain only lowercase letters, numbers, and dashes")
  }
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
  version: 1,
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

const printWorkflows = (workflows: ReadonlyArray<WorkflowArtifact>) => {
  if (workflows.length === 0) {
    console.log("No workflows found.")
    return
  }

  for (const workflow of workflows) {
    const exported = workflow.exportName === undefined ? "" : `#${workflow.exportName}`
    console.log(
      `${workflow.id}\t${workflow.version}\t${workflow.name}${exported}\t${workflow.source.length} bytes`
    )
  }
}

const printCreatedWorkflow = (workflow: WorkflowArtifact) => {
  const exported = workflow.exportName === undefined ? "" : `#${workflow.exportName}`
  console.log(`Created ${workflow.id}\t${workflow.version}\t${workflow.name}${exported}\t${workflow.source.length} bytes`)
}

const printRuns = (runs: ReadonlyArray<WorkflowRunRecord>) => {
  if (runs.length === 0) {
    console.log("No workflow runs found.")
    return
  }

  for (const run of runs) {
    const finishedAt = run.finishedAt ?? "-"
    console.log(
      `${run.id}\t${run.status}\t${run.workflowId}@${run.workflowVersion}\t${run.startedAt}\t${finishedAt}`
    )
  }
}

const printRunEvents = (events: ReadonlyArray<WorkflowRunEventRecord>) => {
  if (events.length === 0) {
    console.log("No workflow run events found.")
    return
  }

  for (const event of events) {
    console.log(
      `${event.sequence}\t${event.createdAt}\t${event.type}\t${stringifyEventValue(event.event)}`
    )
  }
}

const printRunResult = (result: unknown) => {
  if (result === undefined) {
    console.log("Workflow completed.")
    return
  }

  console.log(JSON.stringify(result, null, 2))
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

const errorDetail = (error: unknown): EventDetail => ["error", red(stringifyEventValue(error))]

const reasonDetails = (reason: string | undefined): ReadonlyArray<EventDetail> =>
  reason === undefined ? [] : [["reason", stringifyEventValue(reason)]]

const printWorkflowEvent = (event: WorkflowEvent) => {
  switch (event.type) {
    case "workflow.started":
      printEventLine("workflow", "started", event.workflowName, [
        ["input", stringifyEventValue(event.payload)]
      ])
      return

    case "workflow.completed":
      printEventLine("workflow", "completed", event.workflowName, [
        ["result", stringifyEventValue(event.result)]
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
        ["result", stringifyEventValue(event.result)]
      ])
      return

    case "step.failed":
      printEventLine("step", "failed", event.activityName, [errorDetail(event.error)])
      return

    case "compensation.started":
      printEventLine("compensation", "started", event.activityName, [
        ["reason", stringifyEventValue(event.reason)]
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
        ["duration", stringifyEventValue(event.duration)]
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
        ["payload", stringifyEventValue(event.payload)]
      ])
      return

    case "signal.timeout":
      printEventLine("signal", "timeout", event.activityName, [
        ["timeout", stringifyEventValue(event.timeout)]
      ])
      return

    case "code.started":
      printEventLine("code", "started", event.activityName, reasonDetails(event.reason))
      return

    case "code.completed":
      printEventLine("code", "completed", event.activityName, [
        ...reasonDetails(event.reason),
        ["result", stringifyEventValue(event.result)]
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

type AwaitWorkflowOutcome =
  | { readonly type: "terminal"; readonly result: Awaited<ReturnType<WorkflowClient["result"]>> }
  | { readonly type: "signal-suspended"; readonly pendingSignals: ReadonlyArray<PendingSignal> }

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const waitForSignalSuspension = async (
  client: WorkflowClient,
  executionId: string
): Promise<ReadonlyArray<PendingSignal>> => {
  while (true) {
    const status = await client.status(executionId)
    if (status === "suspended") {
      const pendingSignals = await client.pendingSignals(executionId)
      if (pendingSignals.length > 0) {
        return pendingSignals
      }
    }
    await sleep(100)
  }
}

const awaitWorkflowOutcome = async (
  client: WorkflowClient,
  executionId: string
): Promise<AwaitWorkflowOutcome> =>
  Promise.race([
    client.result(executionId).then((result): AwaitWorkflowOutcome => ({ type: "terminal", result })),
    waitForSignalSuspension(client, executionId).then((pendingSignals): AwaitWorkflowOutcome => ({
      type: "signal-suspended",
      pendingSignals
    }))
  ])

const syncRunEvents = async (
  repository: WorkflowRepository,
  client: WorkflowClient,
  runId: string
) => {
  const existingCount = (await repository.listRunEvents(runId)).length
  const records = (await client.history(runId)).filter((record) => record.sequence > existingCount)

  for (const record of records) {
    await repository.appendRunEvent({
      runId,
      type: record.event.type,
      event: record.event
    })
    if (isPrintableWorkflowEvent(record.event)) {
      printWorkflowEvent(record.event)
    }
  }
}

const awaitSyncAndPersistRun = async (options: {
  readonly repository: WorkflowRepository
  readonly client: WorkflowClient
  readonly runId: string
}) => {
  const outcome = await awaitWorkflowOutcome(options.client, options.runId)
  await syncRunEvents(options.repository, options.client, options.runId)

  if (outcome.type === "signal-suspended") {
    printPendingSignalHint(options.runId, outcome.pendingSignals)
    return
  }

  if (outcome.result.type === "completed") {
    await options.repository.completeRun({ runId: options.runId, result: outcome.result.value })
    printRunResult(outcome.result.value)
    return
  }

  await options.repository.failRun({ runId: options.runId, error: outcome.result.error })
  throw outcome.result.error
}

const engineDatabasePath = (storageDir: string) => path.join(storageDir, "engine.sqlite")

const createEngineBackedClient = (storageDir: string) => {
  const runtime = createWorkflowRuntime({
    backend: "sqlite",
    databasePath: engineDatabasePath(storageDir),
    secrets: envSecretResolver()
  })
  const client = createWorkflowClient(runtime)
  return { runtime, client }
}

export const runWfkitCli = async (options: {
  readonly arguments: ReadonlyArray<string>
  readonly rootDir: string
  readonly storageDir?: string
}): Promise<void> => {
  const [command, ...args] = options.arguments

  if (command === undefined || command === "-h" || command === "--help") {
    console.log(help)
    return
  }

  if (command === "help") {
    const [requestedCommand, ...extraArgs] = args
    if (extraArgs.length > 0) {
      throw new Error(`wf help accepts at most one command\n\n${commandHelp("help")}`)
    }
    const requestedHelp = commandHelp(requestedCommand)
    if (requestedHelp === undefined) {
      throw new Error(`Unknown command: ${requestedCommand}\n\n${help}`)
    }
    console.log(requestedHelp)
    return
  }

  if (args[0] === "-h" || args[0] === "--help") {
    const requestedHelp = commandHelp(command)
    if (requestedHelp === undefined) {
      throw new Error(`Unknown command: ${command}\n\n${help}`)
    }
    console.log(requestedHelp)
    return
  }

  if (command === "integrations") {
    await runIntegrationsCommand(args)
    return
  }

  const rootDir = options.rootDir
  const storageDir = options.storageDir ?? path.join(rootDir, ".wf")
  const repository = createSqliteWorkflowRepository({
    rootDir,
    databasePath: path.join(storageDir, "wf.sqlite")
  })

  switch (command) {
    case "create": {
      const [id, ...createArgs] = args
      const options = await parseCreateWorkflowOptionsWithSource(id, createArgs)
      const existingWorkflow = await repository.get(options.id)

      if (existingWorkflow !== undefined && !options.force) {
        throw new Error(`Workflow id already exists: ${options.id}. Use --force to update it.`)
      }

      // Resolve the actual workflow export from the source instead of
      // assuming the id-derived name — imported files usually export a
      // differently named workflow. --name still pins the export explicitly
      // (needed when a file exports several workflows). This also validates
      // the source at create time instead of on first run.
      const loaded = await loadWorkflowArtifact({
        id: options.id,
        name: options.name,
        version: options.version,
        source: options.source,
        ...(options.nameProvided ? { exportName: options.name } : {})
      })

      const workflow: WorkflowArtifact = {
        id: options.id,
        name: options.nameProvided ? options.name : loaded.workflow.name,
        version: options.version,
        source: options.source,
        exportName: loaded.exportName,
        createdAt: new Date().toISOString()
      }
      if (existingWorkflow !== undefined) {
        // The catalog is keyed by (name, version); replacing an id whose
        // detected name changed must not leave the old row behind.
        await repository.deleteWorkflow(options.id)
      }
      await repository.upsertWorkflow(workflow)
      printCreatedWorkflow(workflow)
      return
    }

    case "list": {
      printWorkflows(await repository.list())
      return
    }

    case "runs": {
      printRuns(await repository.listRuns())
      return
    }

    case "history":
    case "events": {
      const [runId] = args
      if (runId === undefined) {
        throw new Error("wf history requires an execution id")
      }

      printRunEvents(await repository.listRunEvents(runId))
      return
    }

    case "run": {
      const [id, rawInput] = args
      if (id === undefined) {
        throw new Error("wf run requires a workflow id")
      }

      const artifact = await repository.get(id)
      if (artifact === undefined) {
        throw new Error(`Unknown workflow id: ${id}`)
      }
      const loaded = await loadWorkflowArtifact(artifact)
      const input = parseJsonInput(rawInput)
      const { client } = createEngineBackedClient(storageDir)
      const handle = await client.start(loaded.workflow, input)
      console.error(`${eventTag("run")} id ${bold(handle.executionId)}`)
      await repository.startRun({ id: handle.executionId, workflow: artifact, input })

      await awaitSyncAndPersistRun({ repository, client, runId: handle.executionId })
      return
    }

    case "signal": {
      const options = parseSignalCommandOptions(args)
      const run = await repository.getRun(options.runId)
      if (run === undefined) {
        throw new Error(`Unknown workflow run: ${options.runId}`)
      }

      const artifact = await repository.get(run.workflowId)
      if (artifact === undefined) {
        throw new Error(`Workflow artifact was deleted for run ${options.runId}: ${run.workflowId}`)
      }

      const loaded = await loadWorkflowArtifact(artifact)
      const { runtime, client } = createEngineBackedClient(storageDir)
      runtime.register([loaded.workflow])

      try {
        await client.signal(
          options.runId,
          options.signalName,
          options.payload,
          options.actor === undefined ? {} : { actor: options.actor }
        )
      } catch (error) {
        const pendingSignals = await client.pendingSignals(options.runId).catch(() => [])
        if (pendingSignals.length === 0) {
          throw error
        }
        const lines = pendingSignals.map((signal) => describePendingSignal(options.runId, signal))
        throw new Error(`${formatError(error)}\n${lines.join("\n")}`)
      }

      await awaitSyncAndPersistRun({ repository, client, runId: options.runId })
      return
    }

    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`)
  }
}

if (import.meta.main) {
  runWfkitCli({ arguments: process.argv.slice(2), rootDir: process.cwd() }).then(
  () => process.exit(0),
  (error) => {
    console.error(formatError(error))
    process.exit(1)
  }
  )
}
