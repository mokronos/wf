import { describe, expect, test } from "bun:test"
import path from "node:path"
import { repositoryPath, wfHome } from "../src/paths.ts"

describe("global wf paths", () => {
  test("uses WF_HOME when configured", () => {
    const home = wfHome({ WF_HOME: "/tmp/custom-wf" })
    const resolvedHome = path.resolve("/tmp/custom-wf")
    expect(home).toBe(resolvedHome)
    expect(repositoryPath(home)).toBe(path.join(resolvedHome, "wf.sqlite"))
  })

  test("treats an empty WF_HOME as the default", () => {
    expect(wfHome({ WF_HOME: "" })).toBe(wfHome({}))
  })
})
