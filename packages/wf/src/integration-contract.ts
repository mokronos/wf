import { Schema } from "effect"

export const IntegrationAlias = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-z][a-z0-9-]*$/.test(value))
)
export type IntegrationAlias = typeof IntegrationAlias.Type

export const IntegrationSource = Schema.Struct({
  kind: Schema.Literal("gateway"),
  alias: IntegrationAlias,
  tool: Schema.String
})
export type IntegrationSource = typeof IntegrationSource.Type
