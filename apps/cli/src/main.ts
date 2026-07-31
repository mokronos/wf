#!/usr/bin/env bun
import path from "node:path"
import {
  createSqliteWorkflowRepository,
  createWorkflowClient,
  createWorkflowRuntime,
  lifecycleRunRecords,
  toJsonText,
  workflowArtifactToGraph
} from "@mokronos/wfkit"
import type { WorkflowRepository } from "@mokronos/wfkit"
import { runWfkitCli } from "./cli/main.ts"
import assets from "./embedded-web-assets.gen.ts"
import { repositoryPath, wfHome } from "./paths.ts"
import { defaultPort, installService } from "./service.ts"
import packageMetadata from "../package.json" with { type: "json" }

export const topLevelHelp = `wf - durable workflows and a local dashboard

Usage:
  wf <command> [options]

Workflow commands:
  create                  Create or import a workflow
  validate                Validate a workflow without running it
  list                    List registered workflows
  run                     Start a workflow run
  runs                    List persisted runs
  history                 Show the event history for a run
  signal                  Resume a run waiting for a signal
  integrations            Discover, authorize, inspect, and validate integrations

Service and dashboard commands:
  install                 Register and start the per-user local dashboard service
  web                     Open the installed dashboard in your browser
  web --foreground        Run a temporary dashboard in this terminal
  daemon --foreground     Run the dashboard service in the foreground

wf install registers and starts a per-user local dashboard service. It keeps the
dashboard available without a terminal, serves workflow and run history from ~/.wf
at http://127.0.0.1:4787, and does not execute workflows.

Set WF_HOME to use a different global data directory.
`

export const commandHelp = (command: string): string | undefined => {
  switch (command) {
    case "install":
      return `Register and start the per-user local dashboard service.

The service keeps the dashboard available without a terminal. It serves workflow
and run history from ~/.wf at http://127.0.0.1:4787 and does not execute workflows.

Usage:
  wf install
`
    case "web":
      return `Open the installed local dashboard, which serves workflow and run history.

Use --foreground to run a temporary dashboard in this terminal instead of the
per-user service. The dashboard does not execute workflows in either mode.

Usage:
  wf web
  wf web --foreground [--port <port>] [--no-open]
`
    case "daemon":
      return `Run the local dashboard service in this terminal.

This serves workflow and run history from ~/.wf and does not execute workflows.
Use wf install to register and start the per-user service that remains available
without a terminal.

Usage:
  wf daemon --foreground [--port <port>]
`
    default:
      return undefined
  }
}

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
  repository: WorkflowRepository,
  engineDatabasePath: string,
  pathname: string
): Promise<Response> => {
  if (pathname === "/api/workflows") {
    const artifacts = await repository.list()
    const workflows = await Promise.all(artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 })))
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), workflows }))
  }
  if (pathname === "/api/runs") {
    const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: engineDatabasePath })
    const client = createWorkflowClient(runtime)
    try {
      return json(JSON.stringify({
        generatedAt: new Date().toISOString(),
        runs: await lifecycleRunRecords(client, await repository.list())
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
    const runs = await lifecycleRunRecords(client, await repository.list())
    const run = runs.find((candidate) => candidate.id === execution.executionId)
    if (run === undefined) return json(JSON.stringify({ error: "Run not found" }), 404)
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), run, events: await client.history(run.id) }))
  } finally {
    await client.dispose()
  }
}

const parsePort = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error("--port requires an integer between 1 and 65535")
  const port = Number(value)
  if (port < 1 || port > 65535) throw new Error("--port requires an integer between 1 and 65535")
  return port
}

interface ServerOptions {
  readonly foreground: boolean
  readonly open: boolean
  readonly port: number
}

export const parseServerOptions = (arguments_: ReadonlyArray<string>): ServerOptions => {
  let foreground = false
  let open = true
  let port = defaultPort
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === "--foreground") {
      foreground = true
      continue
    }
    if (argument === "--no-open") {
      open = false
      continue
    }
    if (argument === "--port") {
      port = parsePort(arguments_[index + 1])
      index += 1
      continue
    }
    throw new Error(`Unknown dashboard option: ${argument}`)
  }
  return { foreground, open, port }
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
  const repository = createSqliteWorkflowRepository({
    databasePath: repositoryPath(home),
    rootDir: process.cwd()
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: async (request) => {
      const pathname = new URL(request.url).pathname
      if (pathname.startsWith("/api/")) {
        try {
          return await api(repository, path.join(home, "engine.sqlite"), pathname)
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

const runGlobalWfkitCli = (arguments_: ReadonlyArray<string>): Promise<void> =>
  runWfkitCli({
    arguments: arguments_,
    rootDir: process.cwd(),
    storageDir: wfHome()
  })

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

export const main = async (): Promise<void> => {
  const [command, ...arguments_] = process.argv.slice(2)
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(topLevelHelp)
    return
  }
  if (command === "--version" || command === "-v") {
    console.log(packageMetadata.version)
    return
  }
  if (command === "help") {
    if (arguments_.length === 0) {
      console.log(topLevelHelp)
      return
    }
    const [requestedCommand] = arguments_
    const ownHelp = requestedCommand === undefined ? undefined : commandHelp(requestedCommand)
    if (ownHelp !== undefined) {
      console.log(ownHelp)
      return
    }
    if (requestedCommand === "integrations") {
      await runGlobalWfkitCli(["integrations", "--help"])
      return
    }
    await runGlobalWfkitCli([command, ...arguments_])
    return
  }
  if (command === "install") {
    if (arguments_.length > 0) throw new Error("wf install does not accept options")
    await installService(serviceProgram())
    console.log("wf service installed and started")
    return
  }
  if (command === "web") {
    await openInstalledDashboard(parseServerOptions(arguments_))
    return
  }
  if (command === "daemon") {
    if (arguments_[0] !== "--foreground") {
      throw new Error("Usage: wf daemon --foreground")
    }
    const options = parseServerOptions(arguments_.slice(1))
    await runServer({ ...options, foreground: true, open: false })
    return
  }
  await runGlobalWfkitCli([command, ...arguments_])
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
