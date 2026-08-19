// Error has no enumerable own properties, so plain JSON.stringify turns a
// thrown Error into "{}" and history loses the failure message. Keep name,
// message, and any own enumerable fields (e.g. _tag on tagged errors).
// Serialises whatever it is handed, including values that were thrown, so it
// cannot name its input.
// oxlint-disable-next-line anti-slop/no-unknown-parameters anti-slop/no-unknown-returns
const jsonReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Error
    ? { ...value, name: value.name, message: value.message }
    : value

// Serialises whatever it is handed, including values that were thrown, so it
// cannot name its input.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const toJsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value, jsonReplacer) ?? JSON.stringify(String(value))
  } catch {
    return JSON.stringify(String(value))
  }
}

// Serialises whatever it is handed, including values that were thrown, so it
// cannot name its input.
// oxlint-disable-next-line anti-slop/no-unknown-returns
export const parseJsonText = (value: string | null): unknown =>
  value === null ? undefined : JSON.parse(value)
