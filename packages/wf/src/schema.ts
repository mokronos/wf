import { Schema } from "effect"

interface SchemaVocabulary {
  readonly string: typeof Schema.String
  readonly number: typeof Schema.Number
  readonly boolean: typeof Schema.Boolean
  readonly void: typeof Schema.Void
  readonly date: typeof Schema.Date
  readonly struct: typeof Schema.Struct
  readonly array: <S extends Schema.Constraint>(schema: S) => Schema.$Array<S>
  readonly literal: typeof Schema.Literal
  readonly taggedStruct: typeof Schema.TaggedStruct
  readonly optional: <S extends Schema.Constraint>(schema: S) => Schema.optional<S>
  readonly union: typeof Schema.Union
  readonly unknown: typeof Schema.Unknown
}

// `t` is the LLM-facing schema vocabulary. We re-export a small, lowercase
// subset of Effect's `Schema` so authored workflows never import `effect`
// directly. Add primitives here as workflows need them — keep it small.
export const t: SchemaVocabulary = {
  string: Schema.String,
  number: Schema.Number,
  boolean: Schema.Boolean,
  void: Schema.Void,
  date: Schema.Date,
  struct: Schema.Struct,
  array: Schema.Array,
  literal: Schema.Literal,
  taggedStruct: Schema.TaggedStruct,
  optional: Schema.optional,
  union: Schema.Union,
  unknown: Schema.Unknown
} as const
