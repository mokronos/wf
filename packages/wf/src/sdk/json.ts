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

export const toJsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

export const parseJsonText = (value: string | null): unknown =>
  value === null ? undefined : JSON.parse(value)
