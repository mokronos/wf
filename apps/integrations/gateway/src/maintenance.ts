import type { GatewayStore } from "./store.ts"

export type MaintenanceResult = {
  readonly expiredApprovals: number
  readonly expiredAuditArguments: number
}

/** The two things that must happen on a clock rather than on a request.
 *
 * Both are decisions, not cleanups. An approval that expired did not "fail to
 * be answered" — the answer is that the invocation does not happen. Arguments
 * that aged out are the deliberate half of the audit split: the record stays
 * forever, the payload does not. */
export const runMaintenance = async (
  store: GatewayStore,
  at: Date = new Date()
): Promise<MaintenanceResult> => ({
  expiredApprovals: await store.expireApprovals(at),
  expiredAuditArguments: await store.expireAuditArguments(at)
})

export interface MaintenanceLoop {
  stop(): void
}

/** Runs the sweep on an interval. Deliberately fire-and-forget with errors
 * swallowed to a callback: a maintenance failure must never take the gateway
 * down, and the next tick retries anyway. */
export const startMaintenanceLoop = (
  store: GatewayStore,
  options: {
    readonly intervalMs?: number
    // A caught value. TypeScript types every catch binding as unknown because
    // JavaScript lets any value be thrown, so there is nothing narrower to accept.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    readonly onError?: (error: unknown) => void
  } = {}
): MaintenanceLoop => {
  const interval = setInterval(() => {
    void runMaintenance(store).catch((error) => options.onError?.(error))
  }, options.intervalMs ?? 60_000)
  // Never hold the process open on our account.
  interval.unref?.()
  return { stop: () => clearInterval(interval) }
}
