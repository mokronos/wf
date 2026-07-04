import { Schema } from "effect"

// `t` is the LLM-facing schema vocabulary. We re-export a small, lowercase
// subset of Effect's `Schema` so authored workflows never import `effect`
// directly. Add primitives here as workflows need them — keep it small.
export const t = {
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
