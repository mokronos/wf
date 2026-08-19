import { Predicate, Schema } from "effect"

/** Typed bindings for the tools a key can reach.
 *
 * The catalog is discovered per tenant at runtime, so there is no build-time
 * catalog to generate from — whatever shipped in this package would be a
 * snapshot of somebody else's gateway. Generation therefore runs against *your*
 * gateway with *your* key, which has a useful consequence: the generated
 * surface is the grant surface, so least privilege shows up in autocomplete. */

type Json = typeof Schema.Json.Type

export interface GeneratableTool {
  readonly alias: string
  readonly tool: string
  readonly integration: string
  readonly decision: "allow" | "require_approval"
  readonly inputSchema?: Json | undefined
  readonly outputSchema?: Json | undefined
}

export type CodegenTarget = "ts" | "effect"

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const stringArray = (value: Json): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every(Predicate.isString)
    ? value
    : undefined

/** A valid TS identifier for `alias.tool`, e.g. `gmail-work` + `send_email`
 *  becomes `gmailWorkSendEmail`. Dotted vendor tool names are common. */
export const bindingName = (alias: string, tool: string): string => {
  const parts = `${alias}-${tool}`.split(/[^a-zA-Z0-9]+/).filter((part) => part.length > 0)
  const [first, ...rest] = parts
  if (first === undefined) return "tool"
  const head = /^[0-9]/.test(first) ? `t${first}` : first
  return head.toLowerCase() + rest.map((part) =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join("")
}

export const typeName = (alias: string, tool: string, suffix: string): string => {
  const binding = bindingName(alias, tool)
  return binding.charAt(0).toUpperCase() + binding.slice(1) + suffix
}

const quote = (value: string): string => JSON.stringify(value)

/** JSON Schema is open-ended; this covers the subset vendors actually emit and
 * degrades to the permissive type rather than guessing. A wrong-but-narrow type
 * would reject calls the gateway would have accepted, which is worse than a
 * wide one. */
const toTypeScript = (schema: Json | undefined, indent = ""): string => {
  if (schema === undefined || !isObject(schema)) return "unknown"

  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ")
  }
  if ("const" in schema) return JSON.stringify(schema["const"])

  const anyOf = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const rendered = [...new Set(anyOf.map((entry) => toTypeScript(entry, indent)))]
    return rendered.length === 1 ? rendered[0]! : rendered.join(" | ")
  }

  const type = schema["type"]
  const single = Array.isArray(type) ? type[0] : type
  switch (single) {
    case "string":
      return "string"
    case "integer":
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return `ReadonlyArray<${toTypeScript(schema["items"], indent)}>`
    case "object":
    case undefined: {
      const properties = schema["properties"]
      if (!isObject(properties)) return single === "object" ? "Record<string, unknown>" : "unknown"
      const required = new Set(stringArray(schema["required"] ?? null) ?? [])
      const inner = `${indent}  `
      const fields = Object.entries(properties).map(([key, value]) =>
        `${inner}readonly ${JSON.stringify(key)}${required.has(key) ? "" : "?"}: ${
          toTypeScript(value, inner)
        }`
      )
      return fields.length === 0
        ? "Record<string, never>"
        : `{\n${fields.join("\n")}\n${indent}}`
    }
    default:
      return "unknown"
  }
}

/** The Effect Schema equivalent, for `integration({ input, output })`.
 *
 * This is what removes the hand-transcription step: an author no longer copies
 * a schema out of `integrations schema` by eye, so a vendor reshaping a field
 * becomes a typecheck failure at build time rather than a decode failure at
 * 3am. */
const toEffectSchema = (schema: Json | undefined, indent = ""): string => {
  if (schema === undefined || !isObject(schema)) return "t.unknown"

  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return enumValues.every(Predicate.isString)
      ? `t.literals([${enumValues.map((value) => quote(String(value))).join(", ")}])`
      : "t.unknown"
  }

  const anyOf = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    const rendered = [...new Set(anyOf.map((entry) => toEffectSchema(entry, indent)))]
    if (rendered.length === 1) return rendered[0]!
    return `t.union([${rendered.join(", ")}])`
  }

  const type = schema["type"]
  const single = Array.isArray(type) ? type[0] : type
  switch (single) {
    case "string":
      return "t.string"
    case "integer":
    case "number":
      return "t.number"
    case "boolean":
      return "t.boolean"
    case "null":
      return "t.null"
    case "array":
      return `t.array(${toEffectSchema(schema["items"], indent)})`
    case "object":
    case undefined: {
      const properties = schema["properties"]
      if (!isObject(properties)) return "t.unknown"
      const required = new Set(stringArray(schema["required"] ?? null) ?? [])
      const inner = `${indent}  `
      const fields = Object.entries(properties).map(([key, value]) => {
        const rendered = toEffectSchema(value, inner)
        return `${inner}${JSON.stringify(key)}: ${
          required.has(key) ? rendered : `t.optional(${rendered})`
        }`
      })
      return fields.length === 0
        ? "t.struct({})"
        : `t.struct({\n${fields.join(",\n")}\n${indent}})`
    }
    default:
      return "t.unknown"
  }
}

const header = (target: CodegenTarget, gatewayUrl: string): string =>
  `// Generated by \`integrations codegen --target ${target}\`. Do not edit.
//
// Emitted from one client's grants — the key that generated it, or the client
// named by --client. So this file is that caller's authorized surface, and
// adding a tool to it means adding a grant.
// Regenerate after \`integrations grant\` or when \`integrations drift\` reports
// a vendor change; a reshaped schema then fails typecheck instead of failing at
// run time.
//
// Gateway: ${gatewayUrl}
`

export const generateEffectModule = (
  tools: ReadonlyArray<GeneratableTool>,
  gatewayUrl: string
): string => {
  const blocks = tools.map((entry) => {
    const input = typeName(entry.alias, entry.tool, "Input")
    const output = typeName(entry.alias, entry.tool, "Output")
    const approval = entry.decision === "require_approval"
      ? "\n * Calls to this tool are frozen for a human. Retries return the same frozen\n * call rather than asking again, and collect the decision once it lands."
      : ""
    return `/** \`${entry.alias}.${entry.tool}\` on ${entry.integration}.${approval} */
export const ${input} = ${toEffectSchema(entry.inputSchema)}

export const ${output} = ${toEffectSchema(entry.outputSchema)}

export const ${bindingName(entry.alias, entry.tool)} = integration({
  source: { kind: "gateway", alias: ${quote(entry.alias)}, tool: ${quote(entry.tool)} },
  input: ${input},
  output: ${output},
  retry: { attempts: 3, backoff: "exponential" }
})`
  })

  return `${header("effect", gatewayUrl)}
import { integration, t } from "@mokronos/wfkit"

${blocks.join("\n\n")}
`
}

export const generateTypeScriptModule = (
  tools: ReadonlyArray<GeneratableTool>,
  gatewayUrl: string
): string => {
  const blocks = tools.map((entry) => {
    const input = typeName(entry.alias, entry.tool, "Input")
    const output = typeName(entry.alias, entry.tool, "Output")
    return `export type ${input} = ${toTypeScript(entry.inputSchema)}

export type ${output} = ${toTypeScript(entry.outputSchema)}

/** \`${entry.alias}.${entry.tool}\` on ${entry.integration}. */
export const ${bindingName(entry.alias, entry.tool)} = (
  client: GatewayClient,
  input: ${input}
): Promise<InvocationOutcome> =>
  client.execute({
    alias: ${quote(entry.alias)},
    tool: ${quote(entry.tool)},
    arguments: input as never
  })`
  })

  return `${header("ts", gatewayUrl)}
import type { GatewayClient, InvocationOutcome } from "@mokronos/integrations-client"

${blocks.join("\n\n")}
`
}

export const generateModule = (
  target: CodegenTarget,
  tools: ReadonlyArray<GeneratableTool>,
  gatewayUrl: string
): string =>
  target === "effect"
    ? generateEffectModule(tools, gatewayUrl)
    : generateTypeScriptModule(tools, gatewayUrl)
