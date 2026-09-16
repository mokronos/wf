#!/usr/bin/env bun
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Command, Flag } from "effect/unstable/cli"
import { FetchHttpClient, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Cause, Effect, Layer, Path, Schema } from "effect"
import {
  createDirectoryWorkflowCatalog,
  createWorkflowClient,
  createWorkflowRuntime,
  lifecycleRunRecords,
  RunEventsResponse,
  RunsResponse,
  toJsonText,
  workflowArtifactToGraph,
  WorkflowsResponse
} from "@mokronos/wfkit"
import type { WorkflowCatalog } from "@mokronos/wfkit"
import { workflowCommands, type CliRuntimeOptions } from "./cli/main.ts"
import { telemetryLayer } from "@mokronos/observability"
import { dashboardIsEmbedded, dashboardResponse } from "./dashboard-assets.ts"
import { enginePath, wfHome, workflowsPath } from "./paths.ts"
import { defaultPort, installService } from "./service.ts"
import packageMetadata from "../package.json" with { type: "json" }

/** Every dashboard response is produced through the schema the web client
 *  decodes with, so a drift between the two fails here rather than in the
 *  browser. */
const respond = <S extends Schema.Top>(schema: S) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema))
  return (value: S["Type"], status = 200) =>
    Effect.map(encode(value), (body) =>
      HttpServerResponse.text(body, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" }
      }))
}

const DashboardError = Schema.Struct({ error: Schema.String })
const errorResponse = respond(DashboardError)

const generatedAt = () => new Date().toISOString()

/** The dashboard's read model. The SDK client is promise-shaped, so each route
 *  translates it once here rather than letting promise rejections escape as
 *  defects. */
const dashboardApi = (catalog: WorkflowCatalog, engineDatabasePath: string) => {
  const withClient = <A>(
    use: (client: ReturnType<typeof createWorkflowClient>) => Promise<A>
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        createWorkflowClient(createWorkflowRuntime({
          backend: "sqlite",
          databasePath: engineDatabasePath
        }))),
      (client) => Effect.tryPromise(() => use(client)),
      (client) => Effect.promise(() => client.dispose())
    )

  const workflows = Effect.tryPromise(async () => {
    const artifacts = await catalog.list()
    return await Promise.all(
      artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 }))
    )
  }).pipe(Effect.flatMap((workflows) =>
    respond(WorkflowsResponse)({ generatedAt: generatedAt(), workflows })))

  const runs = withClient(async (client) =>
    lifecycleRunRecords(client, await catalog.list())
  ).pipe(Effect.flatMap((runs) => respond(RunsResponse)({ generatedAt: generatedAt(), runs })))

  const runEvents = Effect.fn("dashboard.runEvents")(function* (runId: string) {
    const found = yield* withClient(async (client) => {
      const execution = await client.execution(runId).catch(() => undefined)
      if (execution === undefined) return undefined
      const records = await lifecycleRunRecords(client, await catalog.list())
      const run = records.find((candidate) => candidate.id === execution.executionId)
      return run === undefined ? undefined : { run, events: await client.history(run.id) }
    })
    return found === undefined
      ? yield* errorResponse({ error: "Run not found" }, 404)
      : yield* respond(RunEventsResponse)({ generatedAt: generatedAt(), ...found })
  })

  // An unreachable catalog or engine is a 500 with a message, not a dead
  // dashboard: the browser keeps polling and recovers on its own.
  const orError = <R>(route: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>) =>
    Effect.catchCause(route, (cause) =>
      Effect.andThen(
        Effect.logError("Dashboard request failed", cause),
        errorResponse({ error: "Dashboard request failed" }, 500)
      ))

  return HttpRouter.addAll([
    HttpRouter.route("GET", "/api/workflows", orError(workflows)),
    HttpRouter.route("GET", "/api/runs", orError(runs)),
    HttpRouter.route("GET", "/api/runs/:runId/events", orError(Effect.gen(function* () {
      const params = yield* HttpRouter.params
      return yield* runEvents(decodeURIComponent(params["runId"] ?? ""))
    }))),
    HttpRouter.route("GET", "/*", (request) =>
      orError(dashboardResponse(new URL(request.url, "http://localhost").pathname)))
  ])
}

interface ServerOptions {
  readonly foreground: boolean
  readonly open: boolean
  readonly port: number
}

/** Best effort: a desktop without a browser handler is not a failed command. */
const openBrowser = Effect.fn("openBrowser")(function* (url: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  const [program, ...rest] = args
  yield* spawner.exitCode(ChildProcess.make(program!, rest, {
    stdout: "ignore",
    stderr: "ignore"
  }))
}, (effect) => Effect.ignore(effect))

const runServer = Effect.fn("runServer")(function* (options: ServerOptions) {
  const home = wfHome()
  const catalog = createDirectoryWorkflowCatalog({ directory: workflowsPath(home) })
  const url = `http://127.0.0.1:${options.port}`

  const served = HttpRouter.serve(dashboardApi(catalog, enginePath(home))).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: options.port }))
  )

  yield* Effect.logInfo(`wf dashboard listening at ${url}`)
  if (options.open) yield* openBrowser(url)
  // launch runs the server layer until the fiber is interrupted, which is what
  // the CLI's own SIGINT/SIGTERM handling does.
  return yield* Layer.launch(served)
})

// A compiled binary re-executes itself, but running from source process.execPath is
// bun, so the service also needs the entry point to run. dashboardIsEmbedded is the
// same build-time signal that distinguishes the two.
const serviceProgram = Effect.fnUntraced(function* () {
  const path = yield* Path.Path
  return dashboardIsEmbedded
    ? [process.execPath]
    : [process.execPath, path.resolve(import.meta.dirname, "main.ts")]
})

class DashboardNotRunning extends Schema.TaggedError<DashboardNotRunning>()(
  "DashboardNotRunning",
  { port: Schema.Number }
) {
  override get message(): string {
    return "wf is not running. Install and start it with: wf install"
  }
}

class PortRequiresForeground extends Schema.TaggedError<PortRequiresForeground>()(
  "PortRequiresForeground",
  {}
) {
  override get message(): string {
    return "--port requires --foreground"
  }
}

const openInstalledDashboard = Effect.fn("openInstalledDashboard")(function* (
  options: ServerOptions
) {
  if (options.foreground) return yield* runServer(options)
  if (options.port !== defaultPort) return yield* new PortRequiresForeground()

  const client = yield* HttpClient.HttpClient
  const url = `http://127.0.0.1:${defaultPort}`
  const reachable = yield* client.get(`${url}/api/runs`).pipe(
    Effect.map((response) => response.status < 400),
    Effect.catchCause(() => Effect.succeed(false))
  )
  if (!reachable) return yield* new DashboardNotRunning({ port: defaultPort })

  yield* Effect.logInfo(`Opening ${url}`)
  if (options.open) yield* openBrowser(url)
})

class InvalidPort extends Schema.TaggedError<InvalidPort>()("InvalidPort", {
  port: Schema.Number
}) {
  override get message(): string {
    return "--port requires an integer between 1 and 65535"
  }
}

class ForegroundRequired extends Schema.TaggedError<ForegroundRequired>()(
  "ForegroundRequired",
  {}
) {
  override get message(): string {
    return "Usage: wf daemon --foreground"
  }
}

const validatePort = (port: number) =>
  port < 1 || port > 65535
    ? Effect.fail(new InvalidPort({ port }))
    : Effect.succeed(port)

const makeRootCommand = (runtime: CliRuntimeOptions) => {
  const installCommand = Command.make(
    "install",
    {
      verbose: Flag.Boolean("verbose").pipe(
        Flag.withDefault(false),
        Flag.withAlias("v"),
        Flag.withDescription("Show service-manager output")
      )
    },
    Effect.fnUntraced(function* ({ verbose }) {
      yield* installService(yield* serviceProgram(), verbose)
      yield* Effect.logInfo("wf service installed and started")
    })
  ).pipe(Command.withDescription("Register and start the per-user local dashboard service"))

  const webCommand = Command.make(
    "web",
    {
      foreground: Flag.Boolean("foreground").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Run a temporary dashboard in this terminal")
      ),
      port: Flag.Int("port").pipe(
        Flag.withDefault(defaultPort),
        Flag.withDescription("Dashboard port when running in the foreground")
      ),
      noOpen: Flag.Boolean("no-open").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Do not open the dashboard in a browser")
      )
    },
    Effect.fnUntraced(function* ({ foreground, port, noOpen }) {
      yield* openInstalledDashboard({
        foreground,
        open: !noOpen,
        port: yield* validatePort(port)
      })
    })
  ).pipe(Command.withDescription("Open the installed local dashboard"))

  const daemonCommand = Command.make(
    "daemon",
    {
      foreground: Flag.Boolean("foreground").pipe(
        Flag.withDefault(false),
        Flag.withDescription("Run the dashboard service in this terminal")
      ),
      port: Flag.Int("port").pipe(
        Flag.withDefault(defaultPort),
        Flag.withDescription("Dashboard port")
      )
    },
    Effect.fnUntraced(function* ({ foreground, port }) {
      if (!foreground) return yield* new ForegroundRequired()
      return yield* runServer({ foreground: true, open: false, port: yield* validatePort(port) })
    })
  ).pipe(Command.withDescription("Run the dashboard service in the foreground"))

  return Command.make("wf").pipe(
    Command.withDescription("Durable workflows and a local dashboard"),
    Command.withSubcommands([
      ...workflowCommands(runtime),
      installCommand,
      webCommand,
      daemonCommand
    ] as const)
  )
}

/** The whole CLI as one Effect: every command, the telemetry layer, and the
 *  platform services it runs on. */
const cliProgram = (
  arguments_: ReadonlyArray<string>,
  options: { readonly rootDir: string; readonly storageDir: string }
) =>
  Command.runWith(makeRootCommand({ ...options }), { version: packageMetadata.version })(
    arguments_
  ).pipe(
    Effect.catchTag("ShowHelp", (error) => error.errors.length === 0
      ? Effect.void
      : Effect.sync(() => { process.exitCode = 1 })),
    // No-op unless WF_OTLP_ENDPOINT points somewhere; otherwise every
    // command's Effect.fn spans and logs export as one trace.
    Effect.provide(Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      telemetryLayer({ serviceName: "wf-cli" }).pipe(Layer.provide(FetchHttpClient.layer))
    ))
  )

/** The CLI's whole user-facing contract for failure: the message on stderr and
 *  a non-zero exit. stdout stays reserved for the command's own output, which
 *  `--json` callers parse. */
const reportFailure = (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    const error = Cause.squash(cause)
    console.error(error instanceof Error ? error.message : toJsonText(error))
    process.exitCode = 1
  })

if (import.meta.main) {
  // runMain owns exit codes, turns SIGINT/SIGTERM into an interrupt of the root
  // fiber (which is what stops `wf daemon --foreground`), and flushes stdio
  // before exit. Its own error reporting is off because it logs through the
  // default logger, which writes to stdout.
  BunRuntime.runMain(
    cliProgram(process.argv.slice(2), {
      rootDir: process.cwd(),
      storageDir: wfHome()
    }).pipe(Effect.catchCause(reportFailure)),
    { disableErrorReporting: true }
  )
}
