import { describe, expect, test } from "bun:test"
import { launchdPlist, serviceLabel, systemdQuote, systemdUnit } from "../src/service.ts"

describe("service definitions", () => {
  test("quotes systemd values and includes daemon arguments", () => {
    expect(systemdQuote("/tmp/wf home")).toBe('"/tmp/wf home"')
    expect(systemdUnit({
      program: ["/opt/wf", "daemon", "--foreground", "--port", "4787"],
      environment: { WF_HOME: "/tmp/wf home" },
      workingDirectory: "/tmp/wf home",
      stdoutPath: "/tmp/wf home/logs/wf.log",
      stderrPath: "/tmp/wf home/logs/wf.error.log"
    })).toContain("ExecStart=/opt/wf daemon --foreground --port 4787")
  })

  test("writes a launchd foreground daemon definition", () => {
    const plist = launchdPlist({ program: ["/opt/wf"], home: "/tmp/wf", port: 4787 })
    expect(plist).toContain(`<string>${serviceLabel}</string>`)
    expect(plist).toContain("<string>--foreground</string>")
    expect(plist).toContain("<string>/opt/wf</string>")
  })

  test("keeps every program element for a source install", () => {
    const program = ["/home/me/.bun/bin/bun", "/repo/packages/wf-cli/src/main.ts"]
    expect(launchdPlist({ program, home: "/tmp/wf", port: 4787 }))
      .toContain("<string>/repo/packages/wf-cli/src/main.ts</string>")
    expect(systemdUnit({
      program: [...program, "daemon", "--foreground", "--port", "4787"],
      environment: { WF_HOME: "/tmp/wf" },
      workingDirectory: "/tmp/wf",
      stdoutPath: "/tmp/wf/logs/wf.log",
      stderrPath: "/tmp/wf/logs/wf.error.log"
    })).toContain(
      "ExecStart=/home/me/.bun/bin/bun /repo/packages/wf-cli/src/main.ts daemon --foreground --port 4787"
    )
  })
})
