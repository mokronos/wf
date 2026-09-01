import { Schema } from "effect"
import { whenPresent } from "./optional.ts"

const JsonSchemaType = Schema.Union([Schema.String, Schema.Array(Schema.String)])

export interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>
  readonly const?: Schema.Json
  readonly enum?: ReadonlyArray<Schema.Json>
  readonly anyOf?: ReadonlyArray<JsonSchema>
  readonly oneOf?: ReadonlyArray<JsonSchema>
  readonly items?: JsonSchema
  readonly properties?: { readonly [key: string]: JsonSchema }
  readonly required?: ReadonlyArray<string>
  readonly [key: string]: Schema.Json | JsonSchema | ReadonlyArray<Schema.Json> | ReadonlyArray<JsonSchema> | { readonly [key: string]: JsonSchema } | undefined
}

export const JsonSchema: Schema.Codec<JsonSchema> = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(JsonSchemaType),
    const: Schema.optionalKey(Schema.Json),
    enum: Schema.optionalKey(Schema.Array(Schema.Json)),
    anyOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    oneOf: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    items: Schema.optionalKey(Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema)),
    properties: Schema.optionalKey(Schema.Record(Schema.String, Schema.suspend((): Schema.Codec<JsonSchema> => JsonSchema))),
    required: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  [Schema.Record(Schema.String, Schema.Json)]
)

export type SerializableValue = Schema.Json | undefined | bigint | Date | ReadonlyArray<SerializableValue> | { readonly [key: string]: SerializableValue }
export type WorkflowPayload = Schema.Json | undefined
export const decodeJsonSchema = Schema.decodeUnknownSync(JsonSchema)

export const jsonSchemaOf = (schema: Schema.Top): JsonSchema | undefined => {
  try {
    return simplifyJsonSchema(decodeJsonSchema(Schema.toJsonSchemaDocument(schema).schema))
  } catch {
    return undefined
  }
}

const simplifyJsonSchema = (schema: JsonSchema): JsonSchema => {
  const simplifiedAnyOf = schema.anyOf === undefined ? undefined : [...new Map(
    schema.anyOf.map(simplifyJsonSchema).map((item) => [JSON.stringify(item), item])
  ).values()]
  const simplifiedOneOf = schema.oneOf?.map(simplifyJsonSchema)
  const simplifiedItems = schema.items === undefined ? undefined : simplifyJsonSchema(schema.items)
  const simplifiedProperties = schema.properties === undefined ? undefined : Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [key, simplifyJsonSchema(value)])
  )
  const simplified: JsonSchema = {
    ...schema,
    ...whenPresent("anyOf", simplifiedAnyOf),
    ...whenPresent("oneOf", simplifiedOneOf),
    ...whenPresent("items", simplifiedItems),
    ...whenPresent("properties", simplifiedProperties)
  }
  if (simplifiedAnyOf?.length === 1 && Object.keys(simplified).every((key) => key === "anyOf")) return simplifiedAnyOf[0]!
  return simplified
}
