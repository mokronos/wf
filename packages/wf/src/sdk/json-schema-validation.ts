import { JsonSchema as EffectJsonSchema, Predicate, Schema, SchemaRepresentation } from "effect"
import type { JsonSchema, SerializableValue, WorkflowPayload } from "../schemas.ts"

const RuntimeJsonSchema = Schema.declare<EffectJsonSchema.JsonSchema>(
  (value): value is EffectJsonSchema.JsonSchema =>
    Predicate.isObject(value)
)

/** Validate a value from a JSON Schema persisted in workflow history. */
export const decodePersistedJsonSchema = (
  schema: JsonSchema,
  value: WorkflowPayload
): SerializableValue => {
  const runtimeSchema = Schema.decodeUnknownSync(RuntimeJsonSchema)(schema)
  const document = EffectJsonSchema.fromSchemaDraft2020_12(runtimeSchema)
  return Schema.decodeUnknownSync(
    SchemaRepresentation.toSchema<Schema.Decoder<SerializableValue, never>>(
      SchemaRepresentation.fromJsonSchemaDocument(document)
    )
  )(value)
}
