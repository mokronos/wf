#!/usr/bin/env bun
import { readFile } from "node:fs/promises"
import {
  createWorkflowClient,
  createSqliteWorkflowRepository,
  loadWorkflowArtifact
} from "wf"
import type { WorkflowArtifact, WorkflowEvent, WorkflowRunEventRecord, WorkflowRunRecord } from "wf"

const help = `Usage:
  wf create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]
  wf list
  wf runs
  wf history <execution-id>
  wf run <workflow-id> [json-input]

Examples:
  wf create welcome-email
  wf create email --file examples/email/email.ts
  wf list
  wf runs
  wf run welcome-email '{"message":"hello"}'
`

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

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
  readonly id: string
  readonly name: string
  readonly source: string
  readonly version: string
  readonly force: boolean
}

interface RawCreateWorkflowOptions {
  readonly id: string
  readonly name: string
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

const workflowTemplate = (options: CreateWorkflowOptions): string => `import { defineStep, defineWorkflow, t } from "wf"

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

const stringifyEventValue = (value: unknown): string => {
  if (value === undefined) {
    return "undefined"
  }

  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const printWorkflowEvent = (event: WorkflowEvent) => {
  switch (event.type) {
    case "workflow.started":
      console.error(
        `[workflow] started ${event.workflowName} input=${stringifyEventValue(event.payload)}`
      )
      return

    case "workflow.completed":
      console.error(
        `[workflow] completed ${event.workflowName} result=${stringifyEventValue(event.result)}`
      )
      return

    case "workflow.failed":
      console.error(
        `[workflow] failed ${event.workflowName} error=${stringifyEventValue(event.error)}`
      )
      return

    case "step.started":
      console.error(`[step] started ${event.activityName} attempt=${event.attempt}`)
      return

    case "step.completed":
      console.error(
        `[step] completed ${event.activityName} attempt=${event.attempt} result=${stringifyEventValue(event.result)}`
      )
      return

    case "step.failed":
      console.error(
        `[step] failed ${event.activityName} error=${stringifyEventValue(event.error)}`
      )
      return

    case "compensation.started":
      console.error(
        `[compensation] started ${event.activityName} reason=${stringifyEventValue(event.reason)}`
      )
      return

    case "compensation.completed":
      console.error(`[compensation] completed ${event.activityName}`)
      return

    case "compensation.failed":
      console.error(
        `[compensation] failed ${event.activityName} error=${stringifyEventValue(event.error)}`
      )
      return

    case "sleep.started":
      console.error(
        `[sleep] started ${event.activityName} duration=${stringifyEventValue(event.duration)}`
      )
      return

    case "sleep.completed":
      console.error(`[sleep] completed ${event.activityName}`)
      return

    case "signal.waiting":
      console.error(`[signal] waiting ${event.activityName}`)
      return

    case "signal.received":
      console.error(
        `[signal] received ${event.activityName} payload=${stringifyEventValue(event.payload)}`
      )
      return

    case "signal.timeout":
      console.error(
        `[signal] timeout ${event.activityName} timeout=${stringifyEventValue(event.timeout)}`
      )
      return
  }
}

const main = async () => {
  const [command, ...args] = process.argv.slice(2)
  const rootDir = process.cwd()
  const repository = createSqliteWorkflowRepository({ rootDir })

  switch (command) {
    case "create": {
      const [id, ...createArgs] = args
      const options = await parseCreateWorkflowOptionsWithSource(id, createArgs)
      const existingWorkflow = await repository.get(options.id)

      if (existingWorkflow !== undefined && !options.force) {
        throw new Error(`Workflow id already exists: ${options.id}. Use --force to update it.`)
      }

      const workflow: WorkflowArtifact = {
        id: options.id,
        name: options.name,
        version: options.version,
        source: options.source,
        exportName: options.name,
        createdAt: new Date().toISOString()
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
      const client = createWorkflowClient()
      const handle = await client.start(loaded.workflow, input)
      console.error(`[run] id ${handle.executionId}`)
      await repository.startRun({ id: handle.executionId, workflow: artifact, input })

      const result = await client.result(handle.executionId)
      for (const record of await client.history(handle.executionId)) {
        await repository.appendRunEvent({
          runId: handle.executionId,
          type: record.event.type,
          event: record.event
        })
        printWorkflowEvent(record.event as WorkflowEvent)
      }

      if (result.type === "completed") {
        await repository.completeRun({ runId: handle.executionId, result: result.value })
        printRunResult(result.value)
        return
      }

      await repository.failRun({ runId: handle.executionId, error: result.error })
      throw result.error
    }

    case "-h":
    case "--help":
    case "help":
    case undefined:
      console.log(help)
      return

    default:
      throw new Error(`Unknown command: ${command}\n\n${help}`)
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(formatError(error))
    process.exit(1)
  }
)
