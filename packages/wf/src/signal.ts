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

export type BufferedSignal<T> =
  | { readonly present: false }
  | { readonly present: true; readonly value: T }

export interface SignalTransport {
  getSchema(executionId: string, name: string): AnySchema | undefined
  registerSchema<T>(executionId: string, name: string, schema: AnySchema<T>): void
  deliver(executionId: string, name: string, payload: unknown): Promise<void>
  takeBuffered<T>(executionId: string, name: string, schema: AnySchema<T>): BufferedSignal<T>
  await<T>(
    executionId: string,
    name: string,
    schema: AnySchema<T>,
    options?: { readonly signal?: AbortSignal }
  ): Promise<T>
  cancel(executionId: string, error: unknown): void
  cleanup(executionId: string, error?: unknown): void
}

const keyOf = (executionId: string, name: string): string => `${executionId}\0${name}`

export const decodeSignal = <T>(schema: AnySchema<T>, value: unknown): T => {
  try {
    return Schema.decodeUnknownSync(schema as any)(value) as T
  } catch (cause) {
    throw new SignalDeliveryError("Signal payload failed schema validation", { cause })
  }
}

export const createSignalTransport = (): SignalTransport => {
  const schemas = new Map<string, AnySchema>()
  const buffers = new Map<string, unknown[]>()
  const waiters = new Map<string, SignalWaiter[]>()

  const removeWaiter = (key: string, waiter: SignalWaiter) => {
    const queued = waiters.get(key)
    if (queued === undefined) return
    const index = queued.indexOf(waiter)
    if (index !== -1) queued.splice(index, 1)
    if (queued.length === 0) waiters.delete(key)
  }

  const takeBuffered = <T>(executionId: string, name: string, schema: AnySchema<T>): BufferedSignal<T> => {
    schemas.set(keyOf(executionId, name), schema)
    const key = keyOf(executionId, name)
    const queue = buffers.get(key)
    if (queue === undefined || queue.length === 0) return { present: false }
    const value = queue.shift()
    if (queue.length === 0) buffers.delete(key)
    return { present: true, value: decodeSignal(schema, value) }
  }

  const cancel = (executionId: string, error: unknown) => {
    for (const [key, queued] of waiters) {
      if (!key.startsWith(`${executionId}\0`)) continue
      waiters.delete(key)
      for (const waiter of queued) waiter.reject(error)
    }
  }

  return {
    getSchema(executionId, name) {
      return schemas.get(keyOf(executionId, name))
    },

    registerSchema(executionId, name, schema) {
      schemas.set(keyOf(executionId, name), schema)
    },

    async deliver(executionId, name, payload) {
      const key = keyOf(executionId, name)
      const waiter = waiters.get(key)?.[0]
      if (waiter !== undefined) {
        const decoded = decodeSignal(waiter.schema, payload)
        removeWaiter(key, waiter)
        waiter.resolve(decoded)
        return
      }

      const schema = schemas.get(key)
      const value = schema === undefined ? payload : decodeSignal(schema, payload)
      const queue = buffers.get(key) ?? []
      queue.push(value)
      buffers.set(key, queue)
    },

    takeBuffered(executionId, name, schema) {
      return takeBuffered(executionId, name, schema)
    },

    await(executionId, name, schema, options = {}) {
      const buffered = takeBuffered(executionId, name, schema)
      if (buffered.present) return Promise.resolve(buffered.value)
      const key = keyOf(executionId, name)
      return new Promise((resolve, reject) => {
        const waiter: SignalWaiter = { schema, resolve: resolve as (value: unknown) => void, reject }
        const abort = () => {
          removeWaiter(key, waiter)
          reject(options.signal?.reason ?? new Error("Signal wait cancelled"))
        }
        if (options.signal?.aborted === true) {
          abort()
          return
        }
        const queue = waiters.get(key) ?? []
        queue.push(waiter)
        waiters.set(key, queue)
        options.signal?.addEventListener("abort", abort, { once: true })
      })
    },

    cancel(executionId, error) {
      cancel(executionId, error)
    },

    cleanup(executionId, error = new Error("Signal execution finished")) {
      cancel(executionId, error)
      for (const key of schemas.keys()) {
        if (key.startsWith(`${executionId}\0`)) schemas.delete(key)
      }
      for (const key of buffers.keys()) {
        if (key.startsWith(`${executionId}\0`)) buffers.delete(key)
      }
    }
  }
}

export const defaultSignalTransport = createSignalTransport()

// Backwards-compatible process-local helpers. Production callers should pass
// an execution-owned transport through their adapter instead.
export const getSignalSchema = (executionId: string, name: string): AnySchema | undefined =>
  defaultSignalTransport.getSchema(executionId, name)
export const registerSignalSchema = <T>(executionId: string, name: string, schema: AnySchema<T>) =>
  defaultSignalTransport.registerSchema(executionId, name, schema)
export const deliverSignal = (executionId: string, name: string, payload: unknown): Promise<void> =>
  defaultSignalTransport.deliver(executionId, name, payload)
export const takeBufferedSignal = <T>(executionId: string, name: string, schema: AnySchema<T>): BufferedSignal<T> =>
  defaultSignalTransport.takeBuffered(executionId, name, schema)
export const awaitSignal = <T>(
  executionId: string,
  name: string,
  schema: AnySchema<T>,
  options?: { readonly signal?: AbortSignal }
): Promise<T> => defaultSignalTransport.await(executionId, name, schema, options)
export const cancelSignalWaits = (executionId: string, error: unknown) =>
  defaultSignalTransport.cancel(executionId, error)
export const cleanupSignals = (executionId: string, error?: unknown) =>
  defaultSignalTransport.cleanup(executionId, error)
