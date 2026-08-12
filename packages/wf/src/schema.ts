import { Schema, SchemaTransformation } from "effect"

interface SchemaVocabulary {
  readonly string: typeof Schema.String
  readonly number: typeof Schema.Number
  readonly boolean: typeof Schema.Boolean
  readonly void: typeof Schema.Void
  readonly date: typeof WorkflowDate
  readonly struct: typeof Schema.Struct
  readonly array: <S extends Schema.Top>(schema: S) => Schema.$Array<S>
  readonly literal: typeof Schema.Literal
  readonly taggedStruct: typeof Schema.TaggedStruct
  readonly optional: <S extends Schema.Top>(schema: S) => Schema.optional<S>
  readonly union: typeof Schema.Union
  readonly unknown: typeof Schema.Unknown
}

// Workflow values cross JSON-backed durable boundaries. Prefer the string
// codec when encoding, while still accepting an in-process Date before the
// first persistence round trip.
const WorkflowDate = Schema.Union([Schema.DateFromString, Schema.Date]).pipe(
  Schema.decodeTo(
    Schema.DateValid,
    SchemaTransformation.transform({ decode: (date) => date, encode: (date) => date })
  )
)

// `t` is the LLM-facing schema vocabulary. We re-export a small, lowercase
// subset of Effect's `Schema` so authored workflows never import `effect`
// directly. Add primitives here as workflows need them — keep it small.
export const t: SchemaVocabulary = {
  string: Schema.String,
  number: Schema.Number,
  boolean: Schema.Boolean,
  void: Schema.Void,
  date: WorkflowDate,
  struct: Schema.Struct,
  array: Schema.Array,
  literal: Schema.Literal,
  taggedStruct: Schema.TaggedStruct,
  optional: Schema.optional,
  union: Schema.Union,
  unknown: Schema.Unknown
} as const
