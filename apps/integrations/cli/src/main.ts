#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun"
import { Data, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { defaultGatewayPort } from "@mokronos/integrations-client"
import { integrationsSubcommands } from "./commands.ts"
import { openBrowser } from "./connection.ts"
import { writeStdoutLine } from "./output.ts"
import {
  installService,
  serviceIsRegistered,
  serviceLabel,
  serviceProgram,
  startDetachedGateway,
  uninstallService
} from "./service.ts"
import { upgradeCli } from "./upgrade.ts"
import packageMetadata from "../package.json" with { type: "json" }

/** Starting the gateway is the one command that does not go through a gateway,
 * for the obvious reason. It is here rather than in `wf` because the gateway is
 * the integrations product — `wf` depends on it, not the other way round. */
class ServeError extends Data.TaggedError("ServeError")<{ readonly message: string }> {}

// A caught value. TypeScript types every catch binding as unknown because
// JavaScript lets any value be thrown, so there is nothing narrower to accept.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const serveError = (error: unknown): ServeError =>
  new ServeError({ message: error instanceof Error ? error.message : String(error) })

const loopbackWarning = (host: string): void => {
  if (host !== "127.0.0.1") {
    console.error(
      "Warning: binding outside loopback exposes a credential that unlocks every connection. Terminate TLS in front of it."
    )
  }
}

const runForeground = async (port: number, host: string): Promise<void> => {
  // Imported lazily so every other command stays independent of the
  // gateway package — the CLI is a thin client by construction.
  const { serveGateway } = await import("@mokronos/integrations")
  const running = await serveGateway({ port, hostname: host })
  await Effect.runPromise(writeStdoutLine(`integrations gateway listening at ${running.url}`))
  loopbackWarning(host)
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void running.stop().then(resolve)
    }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
}

const serveCommand = Command.make(
  "serve",
  {
    port: Flag.integer("port").pipe(
      Flag.withDefault(defaultGatewayPort),
      Flag.withDescription(`Port to listen on (default: ${defaultGatewayPort})`)
    ),
    host: Flag.string("host").pipe(
      Flag.withDefault("127.0.0.1"),
      Flag.withDescription("Bind address. Anything other than loopback exposes credentials")
    ),
    detach: Flag.boolean("detach").pipe(
      Flag.withAlias("d"),
      Flag.withDescription(
        "Start in the background and return, waiting until the gateway is ready"
      )
    )
  },
  ({ port, host, detach }) =>
    Effect.tryPromise({
      try: async () => {
        if (!detach) return await runForeground(port, host)
        const started = await startDetachedGateway({ program: serviceProgram(), port, host })
        loopbackWarning(host)
        await Effect.runPromise(writeStdoutLine(
          `integrations gateway listening at ${started.url} (pid ${started.pid})\nlogs: ${started.logPath}\nstop: kill ${started.pid}\nAt login too: integrations install`
        ))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Run the integration gateway, in this terminal or detached"))

/** The control plane is served by the gateway itself, so there is nothing to
 * start here — this only finds it and opens it. It deliberately does not fall
 * back to starting a gateway: a UI that silently launches the thing holding
 * every credential is not a convenience. */
const dashboardCommand = Command.make(
  "dashboard",
  {
    print: Flag.boolean("print").pipe(
      Flag.withDescription("Print the URL instead of opening a browser")
    )
  },
  ({ print }) =>
    Effect.tryPromise({
      try: async () => {
        const { readGatewayConfig, integrationsHome } = await import("@mokronos/integrations-client")
        const config = await readGatewayConfig(integrationsHome())
        if (config === undefined) {
          throw new Error(
            "No gateway found. Start one with `integrations serve`, then try again."
          )
        }
        const healthy = await fetch(`${config.url}/v1/health`).then((response) => response.ok).catch(
          () => false
        )
        if (!healthy) {
          throw new Error(
            `Nothing is answering at ${config.url}. Start the gateway with \`integrations serve\`.`
          )
        }
        if (!print) openBrowser(config.url)
        await Effect.runPromise(writeStdoutLine(
          print ? config.url : `Opening the control plane at ${config.url}`
        ))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Open the gateway's control plane in a browser"))

/** The gateway is a machine-level service, not a session tool: a workflow that
 * touches an integration cannot run without it, and the credentials it holds
 * are what everything else waits on. Registering it with the platform's own
 * per-user service manager is the only way it survives a reboot. */
const installCommand = Command.make(
  "install",
  {
    port: Flag.integer("port").pipe(
      Flag.withDefault(defaultGatewayPort),
      Flag.withDescription(`Port the service listens on (default: ${defaultGatewayPort})`)
    ),
    verbose: Flag.boolean("verbose").pipe(
      Flag.withAlias("v"),
      Flag.withDescription("Show service-manager output")
    )
  },
  ({ port, verbose }) =>
    Effect.tryPromise({
      try: async () => {
        const descriptor = await installService({ program: serviceProgram(), port, verbose })
        await Effect.runPromise(writeStdoutLine(
          `integrations gateway service installed and started as ${serviceLabel} at http://127.0.0.1:${descriptor.port}\nRemove it with: integrations uninstall`
        ))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Register and start the gateway as a per-user service"))

const uninstallCommand = Command.make(
  "uninstall",
  {
    verbose: Flag.boolean("verbose").pipe(
      Flag.withAlias("v"),
      Flag.withDescription("Show service-manager output")
    )
  },
  ({ verbose }) =>
    Effect.tryPromise({
      try: async () => {
        await uninstallService(verbose)
        await Effect.runPromise(writeStdoutLine(
          `${serviceLabel} stopped and deregistered. Connections and credentials were left in place.`
        ))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Stop and deregister the gateway service"))

/** Upgrading does not restart anything: the service keeps serving the version it
 * started with, which is deliberate — a gateway holding live OAuth sessions
 * should go down when the operator says so. It does say what to run. */
const upgradeCommand = Command.make(
  "upgrade",
  {
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Report the available version and change nothing")
    ),
    pull: Flag.boolean("pull").pipe(
      Flag.withDescription("For a source install: fast-forward the checkout it runs from")
    )
  },
  ({ check, pull }) =>
    Effect.tryPromise({
      try: async () => {
        const result = await upgradeCli({
          packageName: "@mokronos/integrations-cli",
          currentVersion: packageMetadata.version,
          command: "integrations upgrade",
          check,
          pull
        })
        const restart = result.changed && await serviceIsRegistered()
          ? ["The installed service is still running the old version. Restart it with: integrations install"]
          : []
        await Effect.runPromise(writeStdoutLine([...result.lines, ...restart].join("\n")))
      },
      catch: serveError
    })
).pipe(Command.withDescription("Upgrade this CLI to the latest published version"))

const rootCommand = Command.make("integrations").pipe(
  Command.withDescription(
    "Discover, authorize, delegate, and invoke integrations through the gateway"
  ),
  Command.withSubcommands([
    ...integrationsSubcommands,
    serveCommand,
    dashboardCommand,
    installCommand,
    uninstallCommand,
    upgradeCommand
  ])
)

export const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  await Effect.runPromise(
    Command.runWith(rootCommand, { version: packageMetadata.version })(argv).pipe(
      Effect.catchTag("ShowHelp", (error) =>
        error.errors.length === 0
          ? Effect.void
          : Effect.sync(() => {
            process.exitCode = 1
          })),
      Effect.provide(BunServices.layer)
    )
  )
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
    process.exitCode = process.exitCode ?? 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
