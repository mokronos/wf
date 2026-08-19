import { whenPresent } from "../optional.ts"
import { Schema } from "effect"
import { isTerminalRunStatus } from "../run-lifecycle.ts"
import type { WorkflowHistoryRecord } from "../schemas.ts"
import type {
  PendingSignal,
  WorkflowClient,
  WorkflowObservation
} from "./client-model.ts"

export const nowIso = (): string => new Date().toISOString()

export const optionalActor = (
  actor: string | undefined
): { readonly actor?: string } => actor === undefined ? {} : { actor }

export const optionalFinishedAt = (
  finishedAt: string | undefined
): { readonly finishedAt?: string } => finishedAt === undefined ? {} : { finishedAt }

export const optionalCursor = (
  cursor: string | undefined
): { readonly cursor?: string } => cursor === undefined ? {} : { cursor }

const PageOffset = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
)

const PageLimit = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** One window into a listing, plus the cursor that reaches the next one. The
 *  cursor is absent rather than null at the end of the list. */
export interface PaginatedPage<T> {
  readonly items: ReadonlyArray<T>
  readonly cursor?: string
}

export const paginate = <T>(
  values: ReadonlyArray<T>,
  options: { readonly cursor?: string; readonly limit?: number }
): PaginatedPage<T> => {
  const start = options.cursor === undefined
    ? 0
    : Schema.decodeUnknownSync(PageOffset)(options.cursor)
  const limit = options.limit === undefined
    ? values.length
    : Schema.decodeUnknownSync(PageLimit)(options.limit)
  const items = values.slice(start, start + limit)
  const cursor = start + limit < values.length ? String(start + limit) : undefined
  return { items, ...optionalCursor(cursor) }
}

export const createSignalDeliveryClaims = () => {
  const claims = new Set<string>()
  const keyOf = (executionId: string, signal: Pick<PendingSignal, "activityName">) =>
    `${executionId}\0${signal.activityName}`
  return {
    claim(executionId: string, signal: Pick<PendingSignal, "name" | "activityName">): void {
      const key = keyOf(executionId, signal)
      if (claims.has(key)) {
        throw new Error(
          `Signal ${signal.name} has already been delivered to execution ${executionId}`
        )
      }
      claims.add(key)
    },
    release(executionId: string, signal: Pick<PendingSignal, "activityName">): void {
      claims.delete(keyOf(executionId, signal))
    },
    clear(): void {
      claims.clear()
    }
  }
}

const signalKey = (event: { readonly name: string; readonly invocation: number }): string =>
  `${event.name}:${event.invocation}`

// Reads the timeout off a pending-signal event, which the event schema declares
// Schema.Unknown.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const optionalTimeout = (timeout: unknown): { readonly timeout?: unknown } =>
  timeout === undefined ? {} : { timeout }

const waitForObservationTick = (
  signal: AbortSignal | undefined
): Promise<void> => new Promise((resolve, reject) => {
  const timeout = setTimeout(finish, 50)
  const abort = () => {
    clearTimeout(timeout)
    reject(signal?.reason ?? new Error("Workflow observation aborted"))
  }
  function finish() {
    signal?.removeEventListener("abort", abort)
    resolve()
  }
  if (signal?.aborted === true) {
    abort()
    return
  }
  signal?.addEventListener("abort", abort, { once: true })
})

export const observeExecution = async (
  client: Pick<WorkflowClient, "status" | "result" | "pendingSignals">,
  executionId: string,
  signal: AbortSignal | undefined
): Promise<WorkflowObservation> => {
  void client.result(executionId)
  while (true) {
    const status = await client.status(executionId)
    if (isTerminalRunStatus(status)) {
      return { type: "terminal", result: await client.result(executionId) }
    }
    if (status === "suspended") {
      const pendingSignals = await client.pendingSignals(executionId)
      if (pendingSignals.length > 0) {
        return { type: "signal-suspended", pendingSignals }
      }
    }
    await waitForObservationTick(signal)
  }
}

export const pendingSignalsFromHistory = (
  history: ReadonlyArray<WorkflowHistoryRecord>
): ReadonlyArray<PendingSignal> => {
  const consumed = new Set<string>()
  for (const record of history) {
    const event = record.event
    if (event.type === "signal.received" || event.type === "signal.timeout") {
      consumed.add(signalKey(event))
    }
  }

  return history.flatMap((record) => {
    const event = record.event
    if (event.type !== "signal.waiting" || consumed.has(signalKey(event))) return []
    return [{
      name: event.name,
      invocation: event.invocation,
      activityName: event.activityName,
      ...optionalTimeout(event.timeout),
      ...whenPresent("payloadSchema", event.payloadSchema)
    }]
  })
}
