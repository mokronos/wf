import { Option } from "effect"

/** The spread form of "include this field only when the value is there".
 *
 *  `exactOptionalPropertyTypes` makes `{ key: undefined }` mean something
 *  different from an absent `key`, so omitting a field inline used to require a
 *  conditional spread of an empty object at every construction site. This says
 *  it once, in terms of Option, and reads as the intent rather than as the
 *  mechanism:
 *
 *  ```ts
 *  { type: "cancellation.received", ...whenPresent("actor", outcome.actor) }
 *  ```
 *
 *  `null` counts as absent alongside `undefined`, because the values feeding
 *  these fields come from SQL columns and JSON bodies as often as from optional
 *  parameters. */
export const whenPresent = <K extends string, V>(
  key: K,
  value: V | null | undefined
): { readonly [P in K]?: V } =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: V } = {}
      field[key] = present
      return field
    }
  })

/** As {@link whenPresent}, but converts the value on the way in. The conversion
 *  never runs for an absent value, which is what lets a branded constructor be
 *  passed here directly. */
export const whenPresentMap = <K extends string, V, W>(
  key: K,
  value: V | null | undefined,
  map: (present: V) => W
): { readonly [P in K]?: W } =>
  Option.match(Option.map(Option.fromNullishOr(value), map), {
    onNone: () => ({}),
    onSome: (present) => {
      const field: { [P in K]?: W } = {}
      field[key] = present
      return field
    }
  })

/** Spread form for a group of fields derived from one possibly-absent value.
 *  Use when presence controls more than one key at once. */
export const whenPresentFields = <V, T extends object>(
  value: V | null | undefined,
  fields: (present: V) => T
) =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => ({}),
    onSome: fields
  })

/** Spread form for a group of fields governed by a plain condition rather than
 *  by a value being present. */
export const whenTrue = <T extends object>(condition: boolean, fields: () => T) =>
  Option.match(condition ? Option.some(undefined) : Option.none(), {
    onNone: () => ({}),
    onSome: fields
  })
