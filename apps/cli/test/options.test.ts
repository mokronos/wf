import { describe, expect, test } from "bun:test"
import { parseServerOptions } from "../src/main.ts"

describe("dashboard options", () => {
  test("opens the installed service by default", () => {
    expect(parseServerOptions([])).toEqual({ foreground: false, open: true, port: 4787 })
  })

  test("parses a temporary foreground server", () => {
    expect(parseServerOptions(["--foreground", "--port", "9000", "--no-open"]))
      .toEqual({ foreground: true, open: false, port: 9000 })
  })

  test("rejects invalid ports", () => {
    expect(() => parseServerOptions(["--port", "70000"])).toThrow("between 1 and 65535")
  })
})
