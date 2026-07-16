export const stableStringify = (value: unknown): string =>
  JSON.stringify(normalizeJson(value))

const normalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalizeJson)
  }

  if (typeof value !== "object" || value === null) {
    return value
  }

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}

  for (const key of Object.keys(input).sort()) {
    output[key] = normalizeJson(input[key])
  }

  return output
}

// Error has no enumerable own properties, so plain JSON.stringify turns a
// thrown Error into "{}" and history loses the failure message. Keep name,
// message, and any own enumerable fields (e.g. _tag on tagged errors).
const jsonReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Error
    ? { ...value, name: value.name, message: value.message }
    : value

export const toJsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value, jsonReplacer) ?? JSON.stringify(String(value))
  } catch {
    return JSON.stringify(String(value))
  }
}

export const parseJsonText = (value: string | null): unknown =>
  value === null ? undefined : JSON.parse(value)
