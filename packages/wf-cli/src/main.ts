#!/usr/bin/env bun
import { createSqliteWorkflowRepository, toJsonText, workflowArtifactToGraph } from "../../wf/src/index.ts"
import type { WorkflowRepository } from "../../wf/src/index.ts"
import { runWfkitCli } from "../../wf/src/cli/main.ts"
import assets from "./embedded-web-assets.gen.ts"
import { repositoryPath, wfHome } from "./paths.ts"
import { defaultPort, installService } from "./service.ts"
import packageMetadata from "../package.json" with { type: "json" }

export const topLevelHelp = `wf - durable workflows and a local dashboard

Usage:
  wf <command> [options]

Workflow commands:
  create                  Create or import a workflow
  list                    List registered workflows
  run                     Start a workflow run
  runs                    List persisted runs
  history                 Show the event history for a run
  signal                  Resume a run waiting for a signal

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

const dashboardResponse = (pathname: string): Response => {
  const asset = assets[pathname === "/" ? "/index.html" : pathname]
  if (asset === undefined) return new Response("Not found", { status: 404 })
  return new Response(Buffer.from(asset.base64, "base64"), {
    headers: { "content-type": asset.contentType.length === 0 ? mimeTypeFor(pathname) : asset.contentType }
  })
}

const api = async (repository: WorkflowRepository, pathname: string): Promise<Response> => {
  if (pathname === "/api/workflows") {
    const artifacts = await repository.list()
    const workflows = await Promise.all(artifacts.map((artifact) => workflowArtifactToGraph(artifact, { maxNodes: 120 })))
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), workflows }))
  }
  if (pathname === "/api/runs") {
    return json(JSON.stringify({ generatedAt: new Date().toISOString(), runs: await repository.listRuns() }))
  }
  const eventRoute = /^\/api\/runs\/([^/]+)\/events$/.exec(pathname)
  if (eventRoute === null) return json(JSON.stringify({ error: "Not found" }), 404)
  const runId = eventRoute[1]
  if (runId === undefined) return json(JSON.stringify({ error: "Not found" }), 404)
  const run = await repository.getRun(decodeURIComponent(runId))
  if (run === undefined) return json(JSON.stringify({ error: "Run not found" }), 404)
  return json(JSON.stringify({ generatedAt: new Date().toISOString(), run, events: await repository.listRunEvents(run.id) }))
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
          return await api(repository, pathname)
        } catch (error) {
          const message = error instanceof Error ? error.message : "Dashboard API request failed"
          return json(JSON.stringify({ error: message }), 500)
        }
      }
      return dashboardResponse(pathname)
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

const executablePath = (): string => process.execPath

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
    await runGlobalWfkitCli([command, ...arguments_])
    return
  }
  if (command === "install") {
    if (arguments_.length > 0) throw new Error("wf install does not accept options")
    await installService(executablePath())
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
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : toJsonText(error))
      process.exit(1)
    }
  )
}
