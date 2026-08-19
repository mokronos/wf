import { whenPresent, whenPresentMap } from "@mokronos/wfkit"
import {
  ConnectionName,
  IntegrationSlug,
  parseToolAddress,
  ToolAddress
} from "@executor-js/sdk/core"
import { Option, Predicate, Schema } from "effect"
import { runExecutor } from "./default-host.ts"
import type { ExecutorRunner } from "./host.ts"
import {
  ExecutorToolAddress,
  ExecutorOwner,
  ExecutorTool,
  ExecutorToolSummary
} from "./schemas.ts"

const ExecutorToolResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), data: Schema.Json }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      status: Schema.optional(Schema.Number)
    })
  })
])

const McpToolEnvelope = Schema.Struct({
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Json)),
  isError: Schema.optional(Schema.Boolean)
})

const McpTextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
})

const McpEnvelopeOutputSchema = Schema.Struct({
  type: Schema.optional(Schema.Literal("object")),
  properties: Schema.Struct({
    content: Schema.Json,
    structuredContent: Schema.optional(Schema.Json),
    isError: Schema.Struct({ const: Schema.Literal(false) })
  })
})

type Json = typeof Schema.Json.Type

const compactMcpOutputSchema: Json = {}

const isMcpEnvelopeOutputSchema = (schema: Json): boolean =>
  Option.isSome(Schema.decodeUnknownOption(McpEnvelopeOutputSchema)(schema))

export const normalizeExecutorToolOutputSchema = (schema: Json): Json =>
  isMcpEnvelopeOutputSchema(schema) ? compactMcpOutputSchema : schema

const mcpText = (content: ReadonlyArray<Json>): string | undefined => {
  const first = content[0]
  if (content.length !== 1 || first === undefined) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(McpTextContent)(first))?.text
}

export const normalizeExecutorToolResult = (data: Json): Json => {
  const envelope = Option.getOrUndefined(Schema.decodeUnknownOption(McpToolEnvelope)(data))
  if (envelope === undefined) return data

  const content = envelope.content ?? []
  const text = mcpText(content)
  if (envelope.isError === true) {
    throw new Error(text ?? "MCP tool returned an error")
  }
  if (envelope.structuredContent !== undefined) return envelope.structuredContent
  if (text !== undefined) {
    return Option.getOrElse(
      Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text),
      () => text
    )
  }
  return content.length > 0 ? content : data
}

const optionalJson = <A>(value: A | undefined) =>
  value === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(value))

export interface ExecutorToolFilter {
  readonly integration?: string
  readonly owner?: ExecutorOwner
  readonly connection?: string
}

/** Either a tool's address, or the integration plus tool name an agent reads
 *  off a listing. */
export interface ExecutorToolTarget {
  readonly integration: string
  readonly name: string
  readonly connection?: string
}

export interface ExecutorTools {
  readonly list: (filter?: ExecutorToolFilter) => Promise<ReadonlyArray<ExecutorTool>>
  readonly summaries: (filter?: ExecutorToolFilter) => Promise<ReadonlyArray<ExecutorToolSummary>>
  readonly describe: (
    target: ExecutorToolAddress | ExecutorToolTarget
  ) => Promise<ExecutorTool>
  readonly execute: (address: ExecutorToolAddress, input: Json) => Promise<Json>
}

/** Tool operations bound to an explicit host/runner. */
export const createExecutorTools = (runner: ExecutorRunner): ExecutorTools => {
  const summaries = async (filter: ExecutorToolFilter = {}) => {
    const tools = await runner.run((executor) => executor.tools.list({
      ...whenPresentMap("integration", filter.integration, IntegrationSlug.make),
      ...whenPresent("owner", filter.owner),
      ...whenPresentMap("connection", filter.connection, ConnectionName.make)
    }))
    const callableTools = tools.filter((tool) => String(tool.address).startsWith("tools."))
    return Schema.decodeUnknownSync(Schema.Array(ExecutorToolSummary))(
      callableTools.map((tool) => ({
        address: String(tool.address),
        name: String(tool.name),
        description: tool.description,
        integration: String(tool.integration),
        owner: tool.owner,
        connection: String(tool.connection)
      }))
    )
  }

  const describeSummary = async (summary: ExecutorToolSummary): Promise<ExecutorTool> => {
    const schema = await runner.run((executor) =>
      executor.tools.schema(ToolAddress.make(summary.address))
    )
    const inputSchema = optionalJson(schema?.inputSchema)
    const outputSchema = optionalJson(schema?.outputSchema)
    const schemaDefinitions = schema?.schemaDefinitions === undefined
      ? undefined
      : Option.getOrUndefined(
          Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(
            schema.schemaDefinitions
          )
        )
    const normalizedOutputSchema = outputSchema === undefined
      ? undefined
      : normalizeExecutorToolOutputSchema(outputSchema)
    const hasMcpEnvelopeOutput = normalizedOutputSchema === compactMcpOutputSchema
    return Schema.decodeUnknownSync(ExecutorTool)({
      ...summary,
      ...whenPresent("inputSchema", inputSchema),
      ...whenPresent("outputSchema", normalizedOutputSchema),
      ...whenPresent("schemaDefinitions", schemaDefinitions),
      ...whenPresent("inputTypeScript", schema?.inputTypeScript),
      ...(hasMcpEnvelopeOutput
        ? { outputTypeScript: "Json" }
        : schema?.outputTypeScript === undefined
          ? {}
          : { outputTypeScript: schema.outputTypeScript }),
      ...whenPresent("typeScriptDefinitions", schema?.typeScriptDefinitions)
    })
  }

  // `tools.<integration>.<owner>.<connection>.<name>`, per ExecutorToolAddress.
  // Narrowing the listing this way keeps a lookup by address as cheap as one by
  // integration and name. The name may itself contain dots, but every segment
  // ahead of it is positional, so destructuring the split is enough.
  const addressFilter = (address: ExecutorToolAddress): ExecutorToolFilter => {
    const parsed = parseToolAddress(address)
    if (parsed === null) return {}
    return {
      integration: String(parsed.integration),
      owner: parsed.owner,
      connection: String(parsed.connection)
    }
  }

  return {
    summaries,
    list: async (filter: ExecutorToolFilter = {}) =>
      await Promise.all((await summaries(filter)).map(describeSummary)),
    describe: async (target) => {
      const isAddress = Predicate.isString(target)
      const candidates = await summaries(
        isAddress
          ? addressFilter(target)
          : {
            integration: target.integration,
            connection: target.connection ?? "default"
          }
      )
      const match = isAddress
        ? candidates.find((candidate) => candidate.address === target)
        : candidates.find((candidate) => candidate.name === target.name)
      if (match === undefined) {
        throw new Error(
          isAddress
            ? `Tool not found: ${target}`
            : `Tool not found: ${target.integration}/${target.name}`
        )
      }
      return await describeSummary(match)
    },
    execute: async (address, input) => {
      const result = await runner.run((executor) => executor.execute(ToolAddress.make(address), input))
      const decoded = await Schema.decodeUnknownPromise(ExecutorToolResult)(result)
      if (!decoded.ok) {
        throw new Error(`${decoded.error.code}: ${decoded.error.message}`)
      }
      return normalizeExecutorToolResult(decoded.data)
    }
  }
}

const defaultTools = createExecutorTools({ run: runExecutor })

/** Lists callable tools exposed by installed integrations and their active
 * connections, with each tool's full input and output schema. */
export const listExecutorTools = defaultTools.list

/** Lists the same tools as `listExecutorTools`, but only their names,
 * addresses, and descriptions. Skips the per-tool schema lookup, so browsing a
 * large integration stays cheap. */
export const listExecutorToolSummaries = defaultTools.summaries

/** Resolves one tool's full detail from its address or from an integration plus
 * tool name. */
export const describeExecutorTool = defaultTools.describe

export const executeExecutorTool = defaultTools.execute
