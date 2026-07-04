import { Schema } from "effect"

// A typed, tagged workflow error. The returned value is both:
//   - a class you `throw new MyError({...})` inside a step's `run`
//   - a Schema the engine uses to (de)serialize the error across replays
//
// Because errors cross the durable boundary they MUST be declared this way
// (not plain `Error`), so the engine can persist and rehydrate them.
export const defineError = <
  Tag extends string,
  Fields extends Schema.Struct.Fields
>(
  tag: Tag,
  fields: Fields
) => {
  // The self-referential generic of `Schema.TaggedError` is awkward to thread
  // through a generic factory; the cast is purely to satisfy that phantom type.
  return Schema.TaggedError<any>()(tag, fields) as Schema.TaggedErrorClass<
    any,
    Tag,
    { readonly _tag: Schema.tag<Tag> } & Fields
  >
}
