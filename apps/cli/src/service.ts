import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { homedir, userInfo } from "node:os"
import { serviceErrorLogPath, serviceLogPath, wfHome } from "./paths.ts"

export class ServiceCommandError extends Schema.TaggedError<ServiceCommandError>()(
  "ServiceCommandError",
  {
    program: Schema.String,
    args: Schema.Array(Schema.String),
    details: Schema.String
  }
) {
  override get message(): string {
    const invocation = `${this.program} ${this.args.join(" ")}`
    return `${invocation} failed${this.details.length === 0 ? "" : `:\n${this.details}`}`
  }
}

export class UnsupportedPlatform extends Schema.TaggedError<UnsupportedPlatform>()(
  "UnsupportedPlatform",
  { platform: Schema.String }
) {
  override get message(): string {
    return "wf install currently supports Linux systemd --user and macOS launchd"
  }
}

export const serviceLabel = "dev.mokronos.wf"
export const defaultPort = 4787

export interface ServiceDescriptor {
  // A program, not a single path: a compiled binary is one element, while a
  // source install is ["<bun>", "<path to main.ts>"].
  readonly program: ReadonlyArray<string>
  readonly home: string
  readonly port: number
}

export interface SystemdUnitOptions {
  readonly program: ReadonlyArray<string>
  readonly environment: Readonly<Record<string, string>>
  readonly workingDirectory: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

const bareSystemdValue = /^[A-Za-z0-9_@%+=:,./-]+$/

export const systemdQuote = (value: string): string => {
  const escapedPercent = value.replaceAll("%", "%%")
  return bareSystemdValue.test(value)
    ? escapedPercent
    : `"${escapedPercent.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`
}

export const systemdUnit = (options: SystemdUnitOptions): string => {
  const command = options.program.map(systemdQuote).join(" ")
  const environment = Object.entries(options.environment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n")
  return `[Unit]
Description=wf workflow dashboard
After=default.target

[Service]
Type=simple
ExecStart=${command}
${environment}
WorkingDirectory=${systemdQuote(options.workingDirectory)}
StandardOutput=${systemdQuote(`append:${options.stdoutPath}`)}
StandardError=${systemdQuote(`append:${options.stderrPath}`)}
Restart=on-failure
RestartSec=3s

[Install]
WantedBy=default.target
`
}

const xmlEscape = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;")

export const launchdPlist = (descriptor: ServiceDescriptor): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel}</string>
  <key>ProgramArguments</key><array>
    ${[...descriptor.program, "daemon", "--foreground", "--port", String(descriptor.port)].map((value) => `<string>${xmlEscape(value)}</string>`).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key><dict><key>WF_HOME</key><string>${xmlEscape(descriptor.home)}</string></dict>
  <key>WorkingDirectory</key><string>${xmlEscape(descriptor.home)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(serviceLogPath(descriptor.home))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(serviceErrorLogPath(descriptor.home))}</string>
</dict></plist>
`

const boundedDetails = (output: string): string => {
  const details = output.trim()
  const limit = 800
  return details.length <= limit
    ? details
    : `${details.slice(0, limit)}… (+${details.length - limit} chars)`
}

/** Runs a service-manager command once, surfacing its output only when it
 *  fails (or streaming it straight through under `--verbose`). */
const runCommand = Effect.fn("service.runCommand")(function* (
  program: string,
  args: ReadonlyArray<string>,
  verbose: boolean
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make(program, [...args], {
    stdout: verbose ? "inherit" : "pipe",
    stderr: verbose ? "inherit" : "pipe"
  })

  const { exitCode, output } = yield* Effect.scoped(Effect.gen(function* () {
    const handle = yield* spawner.spawn(command)
    if (verbose) {
      return { exitCode: yield* handle.exitCode, output: "" }
    }
    // Drained alongside the wait so a chatty command cannot fill its pipe and
    // block before exiting.
    const [output, exitCode] = yield* Effect.all(
      [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
      { concurrency: 2 }
    )
    return { exitCode, output }
  }))

  if (exitCode === 0) return
  return yield* new ServiceCommandError({ program, args, details: boundedDetails(output) })
})

/** Registers and starts the per-user dashboard service for this platform. */
export const installService = Effect.fn("installService")(function* (
  program: ReadonlyArray<string>,
  verbose = false
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = wfHome()
  yield* fs.makeDirectory(path.join(home, "logs"), { recursive: true })

  if (process.platform === "linux") {
    const unitDirectory = path.join(homedir(), ".config", "systemd", "user")
    yield* fs.makeDirectory(unitDirectory, { recursive: true })
    yield* fs.writeFileString(
      path.join(unitDirectory, `${serviceLabel}.service`),
      systemdUnit({
        program: [...program, "daemon", "--foreground", "--port", String(defaultPort)],
        environment: { WF_HOME: home },
        workingDirectory: home,
        stdoutPath: serviceLogPath(home),
        stderrPath: serviceErrorLogPath(home)
      })
    )
    yield* fs.chmod(path.join(unitDirectory, `${serviceLabel}.service`), 0o600)
    yield* runCommand("systemctl", ["--user", "daemon-reload"], verbose)
    yield* runCommand("systemctl", ["--user", "enable", `${serviceLabel}.service`], verbose)
    yield* runCommand("systemctl", ["--user", "restart", `${serviceLabel}.service`], verbose)
    // Lingering is a nicety: without it the service stops at logout, which is
    // a worse dashboard but not a failed install.
    yield* Effect.ignore(runCommand("loginctl", ["enable-linger", userInfo().username], verbose))
    return
  }

  if (process.platform === "darwin") {
    const descriptor: ServiceDescriptor = { program, home, port: defaultPort }
    const agents = path.join(homedir(), "Library", "LaunchAgents")
    const plist = path.join(agents, `${serviceLabel}.plist`)
    const uid = String(process.getuid?.() ?? userInfo().uid)
    yield* fs.makeDirectory(agents, { recursive: true })
    yield* fs.writeFileString(plist, launchdPlist(descriptor))
    yield* fs.chmod(plist, 0o600)
    // A previous agent may not be loaded; booting it out is best-effort.
    yield* Effect.ignore(runCommand("launchctl", ["bootout", `gui/${uid}/${serviceLabel}`], verbose))
    yield* runCommand("launchctl", ["bootstrap", `gui/${uid}`, plist], verbose)
    return
  }

  return yield* new UnsupportedPlatform({ platform: process.platform })
})
