import { Predicate, Schema } from "effect"

const SecretRefPrefix = "secret:"

export const SecretRef = Schema.declare<string>(
  (value): value is string => Predicate.isString(value) && value.startsWith(SecretRefPrefix)
).pipe(Schema.brand("SecretRef"))
export type SecretRef = typeof SecretRef.Type

export const SecretResolutionContext = Schema.Struct({
  resource: Schema.optional(Schema.String)
})
export type SecretResolutionContext = typeof SecretResolutionContext.Type

export interface SecretResolver {
  resolve(name: string, context?: SecretResolutionContext): string | Promise<string>
}

export const secret = (name: string): SecretRef => SecretRef.make(`${SecretRefPrefix}${name}`)

const defaultSecretEnvName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()

export const envSecretResolver = (options: {
  readonly mapping?: Record<string, string>
  readonly fallback?: string
} = {}): SecretResolver => ({
  resolve: (name) => {
    const envName = options.mapping?.[name] ?? defaultSecretEnvName(name)
    const value = process.env[envName]
    if (value !== undefined) return value
    if (options.fallback !== undefined) return options.fallback
    throw new Error(`Secret "${name}" not found: set env var ${envName}`)
  }
})

export const isSecretRef = Schema.is(SecretRef)

export const secretRefName = (value: SecretRef): string =>
  value.slice(SecretRefPrefix.length)

/** Resolve branded secret placeholders recursively at the execution boundary. */
export const resolveSecretReferences = async (
  // Walks arbitrary decoded step input for secret references and returns the same
  // shape with them replaced.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  value: unknown,
  resolver: SecretResolver | undefined
// Walks arbitrary decoded step input for secret references and returns the same
// shape with them replaced.
// oxlint-disable-next-line anti-slop/no-unknown-returns
): Promise<unknown> => {
  if (isSecretRef(value)) {
    if (resolver === undefined) {
      throw new Error(`No secret resolver configured for ${secretRefName(value)}`)
    }
    return resolver.resolve(secretRefName(value))
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => resolveSecretReferences(item, resolver)))
  }

  if (value instanceof Date || !Predicate.isObjectOrArray(value)) {
    return value
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, entry]) => [
      key,
      await resolveSecretReferences(entry, resolver)
    ] as const)
  )
  return Object.fromEntries(entries)
}
