import { Schema } from "effect"

type AnySchema<A = any> = Schema.Codec<A, any, any, any>

export class SignalDeliveryError extends Error {
  readonly _tag = "SignalDeliveryError"

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message)
    this.name = "SignalDeliveryError"
    this.cause = options?.cause
  }
}

interface SignalWaiter {
  readonly schema: AnySchema
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

const schemas = new Map<string, AnySchema>()
const buffers = new Map<string, unknown[]>()
const waiters = new Map<string, SignalWaiter[]>()

const keyOf = (executionId: string, name: string): string => `${executionId}\0${name}`

export const decodeSignal = <T>(schema: AnySchema<T>, value: unknown): T => {
  try {
    return Schema.decodeUnknownSync(schema as any)(value) as T
  } catch (cause) {
    throw new SignalDeliveryError("Signal payload failed schema validation", { cause })
  }
}

export const getSignalSchema = (executionId: string, name: string): AnySchema | undefined =>
  schemas.get(keyOf(executionId, name))

export const registerSignalSchema = <T>(
  executionId: string,
  name: string,
  schema: AnySchema<T>
) => {
  schemas.set(keyOf(executionId, name), schema)
}

export const deliverSignal = async (
  executionId: string,
  name: string,
  payload: unknown
): Promise<void> => {
  const key = keyOf(executionId, name)
  const queuedWaiters = waiters.get(key)
  const waiter = queuedWaiters?.[0]

  if (waiter !== undefined) {
    const decoded = decodeSignal(waiter.schema, payload)
    queuedWaiters!.shift()
    waiter.resolve(decoded)
    return
  }

  const schema = schemas.get(key)
  const value = schema === undefined ? payload : decodeSignal(schema, payload)
  const queue = buffers.get(key) ?? []
  queue.push(value)
  buffers.set(key, queue)
}

export const takeBufferedSignal = <T>(
  executionId: string,
  name: string,
  schema: AnySchema<T>
): T | undefined => {
  registerSignalSchema(executionId, name, schema)
  const key = keyOf(executionId, name)
  const queue = buffers.get(key)
  if (queue === undefined || queue.length === 0) {
    return undefined
  }

  const value = queue.shift()
  if (queue.length === 0) {
    buffers.delete(key)
  }
  return decodeSignal(schema, value)
}

export const awaitSignal = <T>(
  executionId: string,
  name: string,
  schema: AnySchema<T>
): Promise<T> => {
  const buffered = takeBufferedSignal(executionId, name, schema)
  if (buffered !== undefined) {
    return Promise.resolve(buffered)
  }

  const key = keyOf(executionId, name)
  return new Promise((resolve, reject) => {
    const queue = waiters.get(key) ?? []
    queue.push({ schema, resolve: resolve as (value: unknown) => void, reject })
    waiters.set(key, queue)
  })
}

export const cancelSignalWaits = (executionId: string, error: unknown) => {
  for (const [key, queuedWaiters] of waiters) {
    if (!key.startsWith(`${executionId}\0`)) {
      continue
    }
    waiters.delete(key)
    for (const waiter of queuedWaiters) {
      waiter.reject(error)
    }
  }
}
