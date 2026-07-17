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
    const plist = launchdPlist({ executable: "/opt/wf", home: "/tmp/wf", port: 4787 })
    expect(plist).toContain(`<string>${serviceLabel}</string>`)
    expect(plist).toContain("<string>--foreground</string>")
  })
})
