import { Option } from "effect"

/** See the note on the copy in `@mokronos/wfkit`. Duplicated because this
 *  package deliberately depends on nothing but effect. */
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
