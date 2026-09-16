import { Effect, Schema, Semaphore } from "effect"

export interface StepConcurrencyPolicy<I> {
  readonly key?: (input: I) => string
  readonly limit: number
}

export class InvalidConcurrencyLimit extends Schema.TaggedError<InvalidConcurrencyLimit>()(
  "InvalidConcurrencyLimit",
  {
    stepName: Schema.String,
    limit: Schema.Number
  }
) {
  override get message(): string {
    return `Invalid concurrency limit for step ${this.stepName}: ${this.limit}`
  }
}

export interface ConcurrencyLimiter {
  /** Runs `effect` holding one permit of the step's partition. An unset policy
   *  runs it untouched. Interruption while queued gives the permit back. */
  withPermit<I>(
    stepName: string,
    policy: StepConcurrencyPolicy<I> | undefined,
    input: I
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | InvalidConcurrencyLimit, R>
}

/** Any step's policy, held only as the identity of a permit pool. The key
 *  function is contravariant, so every concrete policy is one of these. */
type PolicyIdentity = StepConcurrencyPolicy<never>

interface Partition {
  readonly semaphore: Semaphore.Semaphore
  holders: number
}

/** Creates an isolated set of step semaphores. Partitions belong to the policy
 *  object a step was defined with, so identically named steps in different
 *  workflows never share permits. Each is created on first use and dropped once
 *  its last holder leaves, so a `key` ranging over unbounded input (a customer
 *  id, say) does not accumulate state. */
export const createConcurrencyLimiter = (): ConcurrencyLimiter => {
  const byPolicy = new WeakMap<PolicyIdentity, Map<string, Partition>>()

  const lease = (policy: PolicyIdentity, key: string, limit: number): Partition => {
    const partitions = byPolicy.get(policy) ?? new Map<string, Partition>()
    byPolicy.set(policy, partitions)
    const existing = partitions.get(key)
    const partition = existing ?? { semaphore: Semaphore.makeUnsafe(limit), holders: 0 }
    partition.holders++
    if (existing === undefined) partitions.set(key, partition)
    return partition
  }

  const unlease = (policy: PolicyIdentity, key: string, partition: Partition): void => {
    partition.holders--
    if (partition.holders > 0) return
    const partitions = byPolicy.get(policy)
    partitions?.delete(key)
    if (partitions?.size === 0) byPolicy.delete(policy)
  }

  return {
    withPermit(stepName, policy, input) {
      return (effect) => {
        if (policy === undefined) return effect
        const limit = policy.limit
        if (!Number.isInteger(limit) || limit < 1) {
          return Effect.fail(new InvalidConcurrencyLimit({ stepName, limit }))
        }
        const key = policy.key?.(input) ?? stepName
        return Effect.acquireUseRelease(
          Effect.sync(() => lease(policy, key, limit)),
          (partition) => Semaphore.withPermit(partition.semaphore)(effect),
          (partition) => Effect.sync(() => unlease(policy, key, partition))
        )
      }
    }
  }
}

/** Limiter for direct executeInMemory calls made without a runtime. */
export const defaultConcurrencyLimiter = createConcurrencyLimiter()
