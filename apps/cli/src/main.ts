#!/usr/bin/env bun
import path from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Command, Flag } from "effect/unstable/cli"
import { Data, Effect } from "effect"
import {
  createDirectoryWorkflowCatalog,
  createWorkflowClient,
  createWorkflowRuntime,
  lifecycleRunRecords,
  toJsonText,
  workflowArtifactToGraph
} from "@mokronos/wfkit"
import {
  closeExecutor,
  listIntegrationOverviews,
  setExecutorStorageDirectory
} from "@mokronos/wfkit-executor"
import type { WorkflowCatalog } from "@mokronos/wfkit"
import { makeWorkflowCommands, type CliRuntimeOptions } from "./cli/main.ts"
import assets from "./embedded-web-assets.gen.ts"
import { enginePath, wfHome, workflowsPath } from "./paths.ts"
import { defaultPort, installService } from "./service.ts"
import packageMetadata from "../package.json" with { type: "json" }

const mimeTypeFor = (pathname: string): string => {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8"
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8"
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (pathname.endsWith(".svg")) return "image/svg+xml"
  if (pathname.endsWith(".png")) return "image/png"
  if (pathname.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

const json = (body: string, status = 200): Response => new Response(body, {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
})

// Compiled binaries embed the dashboard at build time. Running from source leaves
// embedded-web-assets.gen.ts as an empty stub, so fall back to apps/web/dist on disk
// and a `vite build` is enough to refresh the dashboard — no binary recompile.
const dashboardIsEmbedded = Object.keys(assets).length > 0
const dashboardSourceDirectory = path.resolve(import.meta.dir, "..", "..", "..", "apps", "web", "dist")

const dashboardFileResponse = async (pathname: string): Promise<Response> => {
  const location = path.resolve(dashboardSourceDirectory, pathname === "/" ? "index.html" : pathname.slice(1))
  const contained = location === dashboardSourceDirectory ||
    location.startsWith(`${dashboardSourceDirectory}${path.sep}`)
  if (!contained) return new Response("Not found", { status: 404 })
  const file = Bun.file(location)
  if (!(await file.exists())) {
    return new Response(
      `Dashboard assets not found at ${dashboardSourceDirectory}. Run: bun run --cwd apps/web build`,
      { status: 404 }
    )
  }
  return new Response(file, { headers: { "content-type": mimeTypeFor(location) } })
}

const dashboardResponse = async (pathname: string): Promise<Response> => {
  if (!dashboardIsEmbedded) return dashboardFileResponse(pathname)
  const asset = assets[pathname === "/" ? "/index.html" : pathname]
  if (asset === undefined) return new Response("Not found", { status: 404 })
  return new Response(Buffer.from(asset.base64, "base64"), {
    headers: { "content-type": asset.contentType.length === 0 ? mimeTypeFor(pathname) : asset.contentType }
  })
}

const api = async (
  catalog: WorkflowCatalog,
  engineDatabasePath: string,
  pathname: string
): Promise<Response> => {
  if (pathname === "/api/workflows") {
    const artifacts = await catalog.list()
    const workflows = await Promise.all(artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 })))
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), workflows }))
  }
  if (pathname === "/api/integrations") {
    return json(JSON.stringify({
      generatedAt: new Date().toISOString(),
      integrations: await listIntegrationOverviews()
    }))
  }
  if (pathname === "/api/runs") {
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: engineDatabasePath })
    const client = createWorkflowClient(runtime)
    try {
      return json(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runs: await lifecycleRunRecords(client, await catalog.list())
      }))
    } finally {
      await client.dispose()
    }
  }
  const eventRoute = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname)
  if (eventRoute === null) return json(JSON.stringify({ error: "Not found" }), 404)
  const runId = eventRoute[1]
  if (runId === undefined) return json(JSON.stringify({ error: "Not found" }), 404)
  const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: engineDatabasePath })
  const client = createWorkflowClient(runtime)
  try {
    const execution = await client.execution(decodeURIComponent(runId)).catch(() => undefined)
    if (execution === undefined) return json(JSON.stringify({ error: "Run not found" }), 404)
    const runs = await lifecycleRunRecords(client, await catalog.list())
    const run = runs.find((candidate) => candidate.id === execution.executionId)
    if (run === undefined) return json(JSON.stringify({ error: "Run not found" }), 404)
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), run, events: await client.history(run.id) }))
  } finally {
    await client.dispose()
  }
}

const validatePort = (port: number): number => {
  if (port < 1 || port > 65535) throw new Error("--port requires an integer between 1 and 65535")
  return port
}

interface ServerOptions {
  readonly foreground: boolean
  readonly open: boolean
  readonly port: number
}

const openBrowser = (url: string): void => {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  Bun.spawn(command, { stdout: "ignore", stderr: "ignore" })
}

const runServer = async (options: ServerOptions): Promise<void> => {
  const home = wfHome()
  const catalog = createDirectoryWorkflowCatalog({ directory: workflowsPath(home) })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith("/api/")) {
        try {
          return await api(catalog, enginePath(home), pathname)
        } catch (error) {
          const message = error instanceof Error ? error.message : "Dashboard API request failed"
          return json(JSON.stringify({ error: message }), 500)
        }
      }
      return await dashboardResponse(pathname)
    }
  })
  const url = `http://127.0.0.1:${server.port}`
  console.log(`wf dashboard listening at ${url}`)
  if (options.open) openBrowser(url)
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.stop(true)
      resolve()
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

// A compiled binary re-executes itself, but running from source process.execPath is
// bun, so the service also needs the entry point to run. dashboardIsEmbedded is the
// same build-time signal that distinguishes the two.
const serviceProgram = (): ReadonlyArray<string> =>
  dashboardIsEmbedded ? [process.execPath] : [process.execPath, path.resolve(import.meta.dir, "main.ts")]

const openInstalledDashboard = async (options: ServerOptions): Promise<void> => {
  if (options.foreground) {
    await runServer(options)
    return
  }
  if (options.port !== defaultPort) {
    throw new Error("--port requires --foreground")
  }
  const url = `http://127.0.0.1:${defaultPort}`
  const response = await fetch(`${url}/api/runs`).catch(() => undefined)
  if (response === undefined || !response.ok) {
    throw new Error("wf is not running. Install and start it with: wf install")
  }
  console.log(`Opening ${url}`)
  if (options.open) openBrowser(url)
}

class ServiceCliError extends Data.TaggedError("ServiceCliError")<{
  readonly message: string
}> {}

const serviceTask = <A>(task: () => Promise<A>): Effect.Effect<A, ServiceCliError> =>
  Effect.tryPromise({
    try: task,
    catch: (error) => new ServiceCliError({
      message: error instanceof Error ? error.message : toJsonText(error)
    })
  })

const makeRootCommand = (runtime: CliRuntimeOptions) => {
  const installCommand = Command.make(
    "install",
    {
      verbose: Flag.boolean("verbose").pipe(
        Flag.withAlias("v"),
        Flag.withDescription("Show service-manager output")
      )
    },
    ({ verbose }) => serviceTask(async () => {
      await installService(serviceProgram(), verbose)
      console.log("wf service installed and started")
    })
  ).pipe(Command.withDescription("Register and start the per-user local dashboard service"))

  const webCommand = Command.make(
    "web",
    {
      foreground: Flag.boolean("foreground").pipe(
        Flag.withDescription("Run a temporary dashboard in this terminal")
      ),
      port: Flag.integer("port").pipe(
        Flag.withDefault(defaultPort),
        Flag.withDescription("Dashboard port when running in the foreground")
      ),
      noOpen: Flag.boolean("no-open").pipe(
        Flag.withDescription("Do not open the dashboard in a browser")
      )
    },
    ({ foreground, port, noOpen }) => serviceTask(() => openInstalledDashboard({
      foreground,
      open: !noOpen,
      port: validatePort(port)
    }))
  ).pipe(Command.withDescription("Open the installed local dashboard"))

  const daemonCommand = Command.make(
    "daemon",
    {
      foreground: Flag.boolean("foreground").pipe(
        Flag.withDescription("Run the dashboard service in this terminal")
      ),
      port: Flag.integer("port").pipe(
        Flag.withDefault(defaultPort),
        Flag.withDescription("Dashboard port")
      )
    },
    ({ foreground, port }) => serviceTask(async () => {
      if (!foreground) throw new Error("Usage: wf daemon --foreground")
      await runServer({ foreground: true, open: false, port: validatePort(port) })
    })
  ).pipe(Command.withDescription("Run the dashboard service in the foreground"))

  return Command.make("wf").pipe(
    Command.withDescription("Durable workflows and a local dashboard"),
    Command.withSubcommands([
      ...makeWorkflowCommands(runtime),
      installCommand,
      webCommand,
      daemonCommand
    ] as const)
  )
}

const runCommandLine = async (
  arguments_: ReadonlyArray<string>,
  runtime: CliRuntimeOptions
): Promise<void> => {
  setExecutorStorageDirectory(runtime.storageDir)
  try {
    await Effect.runPromise(
      Command.runWith(makeRootCommand(runtime), { version: packageMetadata.version })(
        arguments_
      ).pipe(
        Effect.catchTag("ShowHelp", (error) => error.errors.length === 0
          ? Effect.void
          : Effect.sync(() => { process.exitCode = 1 })),
        Effect.provide(BunServices.layer)
      )
    )
  } finally {
    await closeExecutor(runtime.storageDir)
  }
}

export const main = async (): Promise<void> => {
  await runCommandLine(process.argv.slice(2), {
    rootDir: process.cwd(),
    storageDir: wfHome()
  })
}

if (import.meta.main) {
  try {
    await main()
    await new Promise<void>((resolve, reject) => {
      process.stdout.write("", (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
    process.exitCode = process.exitCode ?? 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : toJsonText(error))
    await new Promise<void>((resolve, reject) => {
      process.stderr.write("", (drainError) => {
        if (drainError === undefined || drainError === null) resolve()
        else reject(drainError)
      })
    })
    process.exitCode = 1
  }
}
