import { Schema } from "effect"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  bindingName,
  generateEffectModule,
  generateTypeScriptModule,
  typeName
} from "../src/codegen.ts"
import type { GeneratableTool } from "../src/codegen.ts"

const ticketTool: GeneratableTool = {
  alias: "tickets",
  tool: "tickets.create",
  integration: "acceptance",
  decision: "allow",
  inputSchema: {
    type: "object",
    required: ["title"],
    properties: {
      title: { type: "string" },
      priority: { type: "integer" },
      labels: { type: "array", items: { type: "string" } }
    }
  },
  outputSchema: {
    type: "object",
    required: ["id", "title"],
    properties: { id: { type: "string" }, title: { type: "string" } }
  }
}

describe("binding names", () => {
  test("turns a dotted vendor tool name into a valid identifier", () => {
    expect(bindingName("tickets", "tickets.create")).toBe("ticketsTicketsCreate")
    expect(bindingName("gmail-work", "send_email")).toBe("gmailWorkSendEmail")
  })

  test("does not start an identifier with a digit", () => {
    expect(bindingName("v2", "1create")).toMatch(/^[a-z]/)
  })

  test("derives type names from the same binding", () => {
    expect(typeName("tickets", "tickets.create", "Input")).toBe("TicketsTicketsCreateInput")
  })
})

describe("effect target", () => {
  test("emits schemas and an integration step naming the alias", () => {
    const module_ = generateEffectModule([ticketTool], "http://127.0.0.1:4788")

    expect(module_).toContain('import { integration, t } from "@mokronos/wfkit"')
    expect(module_).toContain('source: { kind: "gateway", alias: "tickets", tool: "tickets.create" }')
    // Required stays bare, optional is wrapped — the distinction the vendor
    // declared, carried through rather than re-guessed by an author.
    expect(module_).toContain('"title": t.string')
    expect(module_).toContain('"priority": t.optional(t.number)')
    expect(module_).toContain('"labels": t.optional(t.array(t.string))')
  })

  test("says when a tool's calls will be frozen for a human", () => {
    const module_ = generateEffectModule(
      [{ ...ticketTool, decision: "require_approval" }],
      "http://127.0.0.1:4788"
    )
    expect(module_).toContain("frozen for a human")
  })

  test("degrades to unknown rather than guessing a narrower type", () => {
    // A wrong-but-narrow schema would reject calls the gateway would accept.
    const module_ = generateEffectModule(
      [{ ...ticketTool, inputSchema: undefined, outputSchema: { type: "weird-vendor-type" } }],
      "http://gateway"
    )
    expect(module_).toContain("t.unknown")
  })

  test("records where it came from and that it is generated", () => {
    const module_ = generateEffectModule([ticketTool], "http://127.0.0.1:4788")
    expect(module_).toContain("Do not edit")
    expect(module_).toContain("http://127.0.0.1:4788")
    expect(module_).toContain("adding a tool to it means adding a grant")
  })
})

describe("ts target", () => {
  test("emits types matching the schema's required fields", () => {
    const module_ = generateTypeScriptModule([ticketTool], "http://gateway")

    expect(module_).toContain('readonly "title": string')
    expect(module_).toContain('readonly "priority"?: number')
    expect(module_).toContain("ReadonlyArray<string>")
    expect(module_).toContain('alias: "tickets"')
  })

  test("renders enums as a union of literals", () => {
    const module_ = generateTypeScriptModule(
      [{
        ...ticketTool,
        inputSchema: {
          type: "object",
          required: ["status"],
          properties: { status: { enum: ["open", "closed"] } }
        }
      }],
      "http://gateway"
    )
    expect(module_).toContain('"open" | "closed"')
  })
})

describe("generated effect modules are real modules", () => {
  test("a generated module type-checks and produces a usable step", async () => {
    const module_ = generateEffectModule([ticketTool], "http://gateway")
    const directory = await mkdtemp(path.join(tmpdir(), "wf-codegen-"))
    const file = path.join(directory, "generated.ts")
    // Written outside the workspace, so the bare specifier is repointed at the
    // real source. What is under test is the emitted code, not where a user
    // happens to put it.
    const wfkit = pathToFileURL(
      path.resolve(import.meta.dir, "../../../../packages/wf/src/index.ts")
    ).href
    await Bun.write(file, module_.replace('"@mokronos/wfkit"', JSON.stringify(wfkit)))
    try {
      // The point of the effect target is removing hand-transcription, so the
      // output has to actually load and behave like a hand-written step.
      // An ES module namespace from a dynamic import holds arbitrary exports; this is
      // what TypeScript itself infers for `await import()`.
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
      const loaded: Record<string, unknown> = await import(pathToFileURL(file).href)
      const step = Schema.decodeUnknownSync(Schema.Struct({
        kind: Schema.String,
        source: Schema.Struct({
          kind: Schema.String,
          alias: Schema.String,
          tool: Schema.String
        })
      }))(loaded["ticketsTicketsCreate"])
      expect(step.kind).toBe("integration")
      expect(step.source).toEqual({
        kind: "gateway",
        alias: "tickets",
        tool: "tickets.create"
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
