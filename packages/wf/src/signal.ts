import type { WorkflowPayload } from "./schemas.ts"
import { Schema } from "effect"

type SynchronousSchema<A = Schema.Schema.Type<Schema.Top>> = Schema.Codec<
  A,
  Schema.Schema.Type<Schema.Top>,
  never,
  never
>

export class SignalDeliveryError extends Schema.TaggedErrorClass<SignalDeliveryError>()(
  "SignalDeliveryError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect)
  }
) {}

interface SignalWaiter {
  /** The payload as it arrived, before this waiter's schema has seen it.
   *  Signals cross a process boundary and are persisted, so JSON is the widest
   *  a payload can honestly be. */
  readonly deliver: (payload: WorkflowPayload) => void
  /** Rejections settle a Promise, so they are Errors rather than arbitrary
   *  values: a Promise rejected with a non-Error loses its stack. */
  readonly reject: (error: Error) => void
}

export type BufferedSignal<T> =
  | { readonly present: false }
  | { readonly present: true; readonly value: T }

export interface SignalTransport {
  getSchema(executionId: string, name: string): SynchronousSchema | undefined
  registerSchema<T>(executionId: string, name: string, schema: SynchronousSchema<T>): void
  deliver(executionId: string, name: string, payload: WorkflowPayload): Promise<void>
  takeBuffered<T>(executionId: string, name: string, schema: SynchronousSchema<T>): BufferedSignal<T>
  await<T>(
    executionId: string,
    name: string,
    schema: SynchronousSchema<T>,
    options?: { readonly signal?: AbortSignal }
  ): Promise<T>
  cancel(executionId: string, error: Error): void
  cleanup(executionId: string, error?: Error): void
}

const keyOf = (executionId: string, name: string): string => `${executionId}\0${name}`

export const decodeSignal = <T>(schema: SynchronousSchema<T>, value: WorkflowPayload): T => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch (cause) {
    throw new SignalDeliveryError({
      message: "Signal payload failed schema validation",
      cause
    })
  }
}

export const createSignalTransport = (): SignalTransport => {
  const schemas = new Map<string, SynchronousSchema>()
  const buffers = new Map<string, WorkflowPayload[]>()
  const waiters = new Map<string, SignalWaiter[]>()

  const removeWaiter = (key: string, waiter: SignalWaiter) => {
    const queued = waiters.get(key)
    if (queued === undefined) return
    const index = queued.indexOf(waiter)
    if (index !== -1) queued.splice(index, 1)
    if (queued.length === 0) waiters.delete(key)
  }

  const takeBuffered = <T>(executionId: string, name: string, schema: SynchronousSchema<T>): BufferedSignal<T> => {
    schemas.set(keyOf(executionId, name), schema)
    const key = keyOf(executionId, name)
    const queue = buffers.get(key)
    if (queue === undefined) return { present: false }
    const value = queue.shift()
    if (value === undefined) return { present: false }
    if (queue.length === 0) buffers.delete(key)
    return { present: true, value: decodeSignal(schema, value) }
  }

  const cancel = (executionId: string, error: Error) => {
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
        waiter.deliver(payload)
        removeWaiter(key, waiter)
        return
      }

      const schema = schemas.get(key)
      // Validate eagerly so a bad payload is refused at delivery rather than
      // surfacing later, but buffer the payload as it arrived: takeBuffered
      // decodes it against the waiter's own schema.
      if (schema !== undefined) decodeSignal(schema, payload)
      const queue = buffers.get(key) ?? []
      queue.push(payload)
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
        const removeAbortListener = () => options.signal?.removeEventListener("abort", abort)
        const waiter: SignalWaiter = {
          deliver: (value) => {
            const decoded = decodeSignal(schema, value)
            removeAbortListener()
            resolve(decoded)
          },
          reject: (error) => {
            removeAbortListener()
            reject(error)
          }
        }
        function abort() {
          removeWaiter(key, waiter)
          waiter.reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error("Signal wait cancelled")
          )
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
export const getSignalSchema = (executionId: string, name: string): SynchronousSchema | undefined =>
  defaultSignalTransport.getSchema(executionId, name)
export const registerSignalSchema = <T>(executionId: string, name: string, schema: SynchronousSchema<T>) =>
  defaultSignalTransport.registerSchema(executionId, name, schema)
export const deliverSignal = (executionId: string, name: string, payload: WorkflowPayload): Promise<void> =>
  defaultSignalTransport.deliver(executionId, name, payload)
export const takeBufferedSignal = <T>(executionId: string, name: string, schema: SynchronousSchema<T>): BufferedSignal<T> =>
  defaultSignalTransport.takeBuffered(executionId, name, schema)
export const awaitSignal = <T>(
  executionId: string,
  name: string,
  schema: SynchronousSchema<T>,
  options?: { readonly signal?: AbortSignal }
): Promise<T> => defaultSignalTransport.await(executionId, name, schema, options)
export const cancelSignalWaits = (executionId: string, error: Error) =>
  defaultSignalTransport.cancel(executionId, error)
export const cleanupSignals = (executionId: string, error?: Error) =>
  defaultSignalTransport.cleanup(executionId, error)
