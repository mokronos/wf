import { describe, expect, test } from "bun:test"
import { commandHelp, topLevelHelp } from "../src/main.ts"

describe("CLI help", () => {
  test("groups workflow commands before service and dashboard commands", () => {
    expect(topLevelHelp).toContain(`Workflow commands:
  create                  Create or import a workflow
  list                    List registered workflows
  run                     Start a workflow run
  runs                    List persisted runs
  history                 Show the event history for a run
  signal                  Resume a run waiting for a signal`)
    expect(topLevelHelp).toContain(`Service and dashboard commands:
  install                 Register and start the per-user local dashboard service
  web                     Open the installed dashboard in your browser
  web --foreground        Run a temporary dashboard in this terminal
  daemon --foreground     Run the dashboard service in the foreground`)
    expect(topLevelHelp.indexOf("Workflow commands:")).toBeLessThan(topLevelHelp.indexOf("Service and dashboard commands:"))
  })

  test("explains that the dashboard service does not execute workflows", () => {
    expect(topLevelHelp).toContain("does not execute workflows")
    expect(commandHelp("install")).toContain("does not execute workflows")
    expect(commandHelp("web")).toContain("does not execute workflows")
    expect(commandHelp("daemon")).toContain("does not execute workflows")
  })
})
