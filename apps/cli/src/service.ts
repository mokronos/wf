import { mkdir, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import path from "node:path"
import { serviceErrorLogPath, serviceLogPath, wfHome } from "./paths.ts"

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

const command = async (
  program: string,
  arguments_: ReadonlyArray<string>,
  verbose: boolean
): Promise<void> => {
  const process_ = Bun.spawn([program, ...arguments_], {
    stdout: verbose ? "inherit" : "pipe",
    stderr: verbose ? "inherit" : "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    process_.exited,
    verbose ? Promise.resolve("") : new Response(process_.stdout).text(),
    verbose ? Promise.resolve("") : new Response(process_.stderr).text()
  ])
  if (exitCode !== 0) {
    const details = [stdout.trim(), stderr.trim()].filter((line) => line.length > 0).join("\n")
    const limit = 800
    const bounded = details.length <= limit
      ? details
      : `${details.slice(0, limit)}… (+${details.length - limit} chars)`
    throw new Error(`${program} ${arguments_.join(" ")} failed${bounded.length === 0 ? "" : `:\n${bounded}`}`)
  }
}

export const installService = async (program: ReadonlyArray<string>, verbose = false): Promise<void> => {
  const home = wfHome()
  await mkdir(path.join(home, "logs"), { recursive: true })
  const descriptor: ServiceDescriptor = { program, home, port: defaultPort }
  if (process.platform === "linux") {
    const unitDirectory = path.join(homedir(), ".config", "systemd", "user")
    await mkdir(unitDirectory, { recursive: true })
    await writeFile(path.join(unitDirectory, `${serviceLabel}.service`), systemdUnit({
      program: [...program, "daemon", "--foreground", "--port", String(defaultPort)],
      environment: { WF_HOME: home }, workingDirectory: home,
      stdoutPath: serviceLogPath(home), stderrPath: serviceErrorLogPath(home)
    }), { mode: 0o600 })
    await command("systemctl", ["--user", "daemon-reload"], verbose)
    await command("systemctl", ["--user", "enable", `${serviceLabel}.service`], verbose)
    await command("systemctl", ["--user", "restart", `${serviceLabel}.service`], verbose)
    await command("loginctl", ["enable-linger", userInfo().username], verbose).catch(() => undefined)
    return
  }
  if (process.platform === "darwin") {
    const agents = path.join(homedir(), "Library", "LaunchAgents")
    const plist = path.join(agents, `${serviceLabel}.plist`)
    await mkdir(agents, { recursive: true })
    await writeFile(plist, launchdPlist(descriptor), { mode: 0o600 })
    await command("launchctl", ["bootout", `gui/${process.getuid?.() ?? userInfo().uid}/${serviceLabel}`], verbose).catch(() => undefined)
    await command("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? userInfo().uid}`, plist], verbose)
    return
  }
  throw new Error("wf install currently supports Linux systemd --user and macOS launchd")
}
