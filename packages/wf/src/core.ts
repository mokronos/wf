import { createHash } from "node:crypto"
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"
import { Cause, Context, Effect, Exit, Option, Schedule, Schema } from "effect"
import type * as Duration from "effect/Duration"
import { currentWorkflowEventSink, emitWorkflowEvent } from "./events.ts"
import type { WorkflowEvent } from "./schemas.ts"
import { ExecutionId, jsonSchemaOf } from "./schemas.ts"
import { awaitSignal, registerSignalSchema, SignalDeliveryError, takeBufferedSignal } from "./signal.ts"

type AnySchema<A = any> = Schema.Codec<A, any, any, any>

const TerminalFailureTypeId: unique symbol = Symbol.for("wf/TerminalFailure")

export interface TerminalFailure<E> {
  readonly [TerminalFailureTypeId]: typeof TerminalFailureTypeId
  readonly error: E
}

export interface StepContext<E> {
  fail(error: E): TerminalFailure<E>
  readonly attempt: number
  readonly executionId: string
}

export interface StepRetryPolicy {
  readonly attempts: number
  readonly backoff: "exponential" | "none"
}

export interface StepConcurrency<I> {
  readonly key?: (input: I) => string
  readonly limit: number
}

export interface Step<I, O, E = never> {
  readonly name: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors: AnySchema<E>
  readonly execute: (input: I, step: StepContext<E>) => Promise<O | TerminalFailure<E>>
  readonly compensate?: (result: O, input: I, reason: unknown) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<I>
}

export interface DefineStepConfig<I, O, E> {
  readonly name: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors?: AnySchema<E>
  readonly execute: (input: I, step: StepContext<E>) => Promise<O | TerminalFailure<E>>
  readonly compensate?: (result: O, input: I, reason: unknown) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<I>
}

export const defineStep = <
  const Input extends AnySchema,
  const Output extends AnySchema,
  const Errors extends AnySchema = typeof Schema.Never
>(config: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    step: StepContext<Schema.Schema.Type<Errors>>
  ) => Promise<Schema.Schema.Type<Output> | TerminalFailure<Schema.Schema.Type<Errors>>>
  readonly compensate?: (
    result: Schema.Schema.Type<Output>,
    input: Schema.Schema.Type<Input>,
    reason: unknown
  ) => unknown | Promise<unknown>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<Schema.Schema.Type<Input>>
}): Step<Schema.Schema.Type<Input>, Schema.Schema.Type<Output>, Schema.Schema.Type<Errors>> => ({
  ...config,
  errors: config.errors ?? Schema.Never
})

const SecretRefPrefix = "secret:"

export const SecretRef = Schema.declare<string>(
  (value): value is string => typeof value === "string" && value.startsWith(SecretRefPrefix)
).pipe(Schema.brand("SecretRef"))

export type SecretRef = typeof SecretRef.Type

export interface SecretResolver {
  resolve(name: string): string | Promise<string>
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
    if (value !== undefined) {
      return value
    }
    if (options.fallback !== undefined) {
      return options.fallback
    }
    throw new Error(`Secret "${name}" not found: set env var ${envName}`)
  }
})

export const isSecretRef = (value: unknown): value is SecretRef =>
  Schema.is(SecretRef)(value)

const secretName = (value: SecretRef): string => value.slice(SecretRefPrefix.length)

export const currentSecretResolver = Context.Reference<SecretResolver | undefined>(
  "wf/currentSecretResolver",
  { defaultValue: () => undefined }
)

// Durable executions run on engine entity fibers that don't inherit the
// caller's context reference, so the runtime also registers resolvers per execution.
const executionSecretResolvers = new Map<string, SecretResolver>()

export const setExecutionSecretResolver = (executionId: string, resolver: SecretResolver): void => {
  executionSecretResolvers.set(executionId, resolver)
}

export const removeExecutionSecretResolver = (executionId: string): void => {
  executionSecretResolvers.delete(executionId)
}

export const getExecutionSecretResolver = (executionId: string): SecretResolver | undefined =>
  executionSecretResolvers.get(executionId)

export type WorkflowValue<A, E = never> = Effect.Effect<A, E, any>

export type OrchestrationKind = "step" | "sleep" | "signal" | "now" | "random" | "code" | "all"

export interface OrchestrationCall {
  readonly kind: OrchestrationKind
  readonly name: string
  readonly counter: number
  readonly branches?: number
}

type WorkflowValueSuccess<EffectValue> =
  EffectValue extends WorkflowValue<infer A, any> ? A : never

type WorkflowValueError<EffectValue> =
  EffectValue extends WorkflowValue<any, infer E> ? E : never

type WorkflowAllSuccess<Effects extends ReadonlyArray<WorkflowValue<any, any>>> = {
  -readonly [K in keyof Effects]: WorkflowValueSuccess<Effects[K]>
}

type WorkflowAllError<Effects extends ReadonlyArray<WorkflowValue<any, any>>> =
  WorkflowValueError<Effects[number]>

export type SignalOutcome<T> =
  | { readonly type: "signal"; readonly value: T }
  | { readonly type: "timeout" }

export class Cancelled extends Error {
  readonly _tag = "Cancelled"
  readonly _wfSkipCompensation?: true

  constructor(options: { readonly compensate: boolean }) {
    super("Workflow execution cancelled")
    this.name = "Cancelled"
    if (!options.compensate) {
      this._wfSkipCompensation = true
    }
  }
}

/** Reserved per-execution deferred the durable client completes to request
 *  cancellation. Every suspension point races against it. */
export const cancellationDeferredName = "wf:cancel"

const CancellationRequestSchema = Schema.Struct({
  compensate: Schema.Boolean,
  actor: Schema.optional(Schema.String)
})

export class NonDeterminismError extends Error {
  readonly _tag = "NonDeterminismError"
  readonly expected: OrchestrationCall
  readonly actual: OrchestrationCall

  constructor(options: { readonly expected: OrchestrationCall; readonly actual: OrchestrationCall }) {
    super(
      `Non-deterministic workflow replay: expected ${formatCall(options.expected)} but saw ${formatCall(options.actual)}`
    )
    this.name = "NonDeterminismError"
    this.expected = options.expected
    this.actual = options.actual
  }
}

export interface WorkflowContext<WErrors> {
  readonly executionId: string
  run<I, O, E>(step: Step<I, O, E>, input: I): WorkflowValue<O, E | NonDeterminismError>
  sleep(duration: Duration.Input, name?: string): WorkflowValue<void, NonDeterminismError>
  waitForSignal<T>(
    name: string,
    schema: AnySchema<T>,
    opts?: { readonly timeout?: Duration.Input }
  ): WorkflowValue<SignalOutcome<T>, NonDeterminismError | SignalDeliveryError>
  now(): WorkflowValue<Date, NonDeterminismError>
  random(): WorkflowValue<number, NonDeterminismError>
  code<T>(name: string, options: {
    readonly reason?: string
    readonly run: () => T | Promise<T>
  }): WorkflowValue<T, NonDeterminismError>
  all<const Effects extends ReadonlyArray<WorkflowValue<any, any>>>(
    effects: Effects,
    options?: { readonly name?: string; readonly concurrency?: number | "unbounded" }
  ): WorkflowValue<WorkflowAllSuccess<Effects>, WorkflowAllError<Effects> | NonDeterminismError>
  fail(error: WErrors): WorkflowValue<never, WErrors>
  effect<A, E, R>(effect: Effect.Effect<A, E, R>): WorkflowValue<A, E>
}

export interface DefineWorkflowConfig<I, O, WErrors = never> {
  readonly name: string
  readonly version: number
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors?: AnySchema<WErrors>
  readonly run: (input: I, ctx: WorkflowContext<WErrors>) => Generator<any, O, any>
}

export const DefinedWorkflowTypeId = Symbol.for("wf/DefinedWorkflow")

export interface DefinedWorkflow<I = any, O = any, WErrors = any> {
  readonly [DefinedWorkflowTypeId]: typeof DefinedWorkflowTypeId
  readonly name: string
  readonly version: number
  readonly engineName: string
  readonly sourceHash: string
  readonly input: AnySchema<I>
  readonly output: AnySchema<O>
  readonly errors: AnySchema<WErrors>
  readonly workflow: any
  readonly layer: any
  readonly execute: (payload: I) => Effect.Effect<O, WErrors | unknown, any>
  readonly executeInMemory: (payload: I, options?: InMemoryExecutionOptions) => Promise<O>
}

export interface InMemoryExecutionOptions {
  readonly executionId?: string
  readonly determinism?: InMemoryDeterminismState
  readonly onEvent?: (event: WorkflowEvent) => void | Promise<void>
  readonly stepExecutors?: ReadonlyMap<Step<any, any, any>, Step<any, any, any>["execute"]>
  readonly stepExecutor?: (options: {
    readonly step: Step<any, any, any>
    readonly input: unknown
    readonly invocation: number
    readonly activityName: string
    readonly context: StepContext<any>
  }) => unknown | Promise<unknown>
  readonly sleep?: (options: {
    readonly executionId: string
    readonly name: string
    readonly duration: Duration.Input
  }) => Promise<void>
  readonly signalTimeout?: (options: {
    readonly executionId: string
    readonly name: string
    readonly duration: Duration.Input
  }) => Promise<void>
  readonly signalValue?: (options: {
    readonly executionId: string
    readonly name: string
    readonly schema: AnySchema
  }) => unknown | Promise<unknown>
  readonly secrets?: SecretResolver
}

export interface InMemoryDeterminismState {
  readonly calls: OrchestrationCall[]
  readonly blocks: Array<{
    readonly call: OrchestrationCall
    readonly branches: ReadonlyArray<ReadonlyArray<OrchestrationCall>>
  }>
  readonly values: Map<string, unknown>
}

interface CompensationEntry {
  readonly stepName: string
  readonly invocation: number
  readonly result: unknown
  readonly input: unknown
  readonly compensate: (result: unknown, input: unknown, reason: unknown) => unknown | Promise<unknown>
}

type ActivityFailure =
  | { readonly _wfFailureType: "terminal"; readonly error: unknown }
  | { readonly _wfFailureType: "transient"; readonly error: unknown }

class AsyncFailure extends Error {
  readonly _tag = "AsyncFailure"
  readonly error: unknown

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Async operation failed")
    this.name = "AsyncFailure"
    this.error = error
  }
}

const OrchestrationCallSchema: AnySchema = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal("step"),
    Schema.Literal("sleep"),
    Schema.Literal("signal"),
    Schema.Literal("now"),
    Schema.Literal("random"),
    Schema.Literal("code"),
    Schema.Literal("all")
  ]),
  name: Schema.String,
  counter: Schema.Number,
  branches: Schema.optional(Schema.Number)
})

export const createInMemoryDeterminismState = (): InMemoryDeterminismState => ({
  calls: [],
  blocks: [],
  values: new Map()
})

const formatCall = (call: OrchestrationCall): string =>
  `${call.kind}:${call.name}#${call.counter}${call.branches === undefined ? "" : ` branches=${call.branches}`}`

const callsEqual = (left: OrchestrationCall, right: OrchestrationCall): boolean =>
  left.kind === right.kind &&
  left.name === right.name &&
  left.counter === right.counter &&
  left.branches === right.branches

const verifyCall = (expected: OrchestrationCall, actual: OrchestrationCall) => {
  if (!callsEqual(expected, actual)) {
    throw new NonDeterminismError({ expected, actual })
  }
}

const valueKey = (call: OrchestrationCall): string => formatCall(call)

const skipsCompensation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _wfSkipCompensation?: unknown })._wfSkipCompensation === true

const isTerminalFailure = <E>(value: unknown): value is TerminalFailure<E> =>
  typeof value === "object" &&
  value !== null &&
  (value as { readonly [TerminalFailureTypeId]?: unknown })[TerminalFailureTypeId] ===
    TerminalFailureTypeId

const isActivityFailure = (value: unknown): value is ActivityFailure =>
  typeof value === "object" &&
  value !== null &&
  ((value as { readonly _wfFailureType?: unknown })._wfFailureType === "terminal" ||
    (value as { readonly _wfFailureType?: unknown })._wfFailureType === "transient")

const unwrapActivityFailure = (error: unknown): unknown =>
  isActivityFailure(error) ? error.error : error

const unwrapAsyncFailure = (error: unknown): unknown =>
  error instanceof AsyncFailure ? error.error : error

const makeStepContext = <E>(executionId: string, attempt: number): StepContext<E> => ({
  attempt,
  executionId,
  fail: (error) => ({ [TerminalFailureTypeId]: TerminalFailureTypeId, error })
})

const nextInvocation = (counters: Map<string, number>, name: string): number => {
  const invocation = (counters.get(name) ?? 0) + 1
  counters.set(name, invocation)
  return invocation
}

const decodeSync = <A>(schema: AnySchema<A>, value: unknown): A =>
  Schema.decodeUnknownSync(schema as any)(value) as A

const encodeSync = <A>(schema: AnySchema<A>, value: A): unknown =>
  Schema.encodeSync(schema as any)(value)

const resolveSecretRefs = async <A>(value: A, resolver: SecretResolver | undefined): Promise<A> => {
  if (isSecretRef(value)) {
    if (resolver === undefined) {
      throw new Error(`No secret resolver configured for ${secretName(value)}`)
    }
    return await resolver.resolve(secretName(value)) as A
  }

  if (Array.isArray(value)) {
    return await Promise.all(value.map((item) => resolveSecretRefs(item, resolver))) as A
  }

  if (value instanceof Date || typeof value !== "object" || value === null) {
    return value
  }

  const entries = await Promise.all(
    Object.entries(value).map(async ([key, entry]) => [key, await resolveSecretRefs(entry, resolver)] as const)
  )
  return Object.fromEntries(entries) as A
}

interface SemaphoreState {
  active: number
  readonly queue: Array<() => void>
}

const concurrencySemaphores = new Map<string, SemaphoreState>()

const acquireConcurrency = async <I>(step: Step<I, any, any>, input: I): Promise<() => void> => {
  const limit = step.concurrency?.limit
  if (limit === undefined) {
    return () => undefined
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid concurrency limit for step ${step.name}: ${limit}`)
  }

  const key = step.concurrency?.key?.(input) ?? step.name
  const semaphoreKey = `${step.name}\0${key}`
  const state = concurrencySemaphores.get(semaphoreKey) ?? { active: 0, queue: [] }
  concurrencySemaphores.set(semaphoreKey, state)

  if (state.active >= limit) {
    await new Promise<void>((resolve) => {
      state.queue.push(resolve)
    })
  }

  state.active++
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    state.active--
    const next = state.queue.shift()
    if (next !== undefined) {
      next()
    }
    if (state.active === 0 && state.queue.length === 0) {
      concurrencySemaphores.delete(semaphoreKey)
    }
  }
}

// Durable race with a persisted winner. This deliberately does NOT use
// DurableDeferred.raceAll: its replay path runs `Effect.flatten(exit)` over
// the stored winner, which dies with "Not a valid effect" for plain (non-
// Effect) winner values. We store/unwrap the same way DurableDeferred.await
// does — a single `yield*` of the persisted exit.
const raceDurable = (
  name: string,
  effects: ReadonlyArray<Effect.Effect<any, any, any>>
): Effect.Effect<any, any, any> =>
  Effect.gen(function* () {
    const deferred = DurableDeferred.make(name, { success: Schema.Unknown })
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(deferred),
      Option.isNone
    )
    if (Option.isSome(exit)) {
      return yield* exit.value as Exit.Exit<any, any>
    }
    return yield* DurableDeferred.into(Effect.raceAll(effects) as any, deferred as any)
  })

const retrySchedule = (retry: StepRetryPolicy | undefined) => {
  const attempts = Math.max(1, retry?.attempts ?? 1)
  const recurs = Schedule.recurs(attempts - 1)
  return retry?.backoff === "exponential"
    ? Schedule.exponential("10 millis").pipe(Schedule.both(recurs))
    : recurs
}

const transientAttempts = (retry: StepRetryPolicy | undefined): number =>
  Math.max(1, retry?.attempts ?? 1)

const makeCtx = <WErrors>(
  wf: any,
  executionId: ExecutionId,
  workflowErrors: AnySchema<WErrors>
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let parallelDepth = 0

  const recordCall = (actual: OrchestrationCall): Effect.Effect<void, NonDeterminismError, any> => {
    const position = ++journalPosition
    const activityName = parallelDepth > 0
      ? `determinism:${actual.kind}:${actual.name}#${actual.counter}`
      : `determinism#${position}`
    return Activity.make({
      name: activityName,
      success: OrchestrationCallSchema,
      execute: Effect.succeed(actual)
    }).pipe(
      Effect.flatMap((expected) =>
        callsEqual(expected, actual)
          ? Effect.void
          : Effect.fail(new NonDeterminismError({ expected, actual }))
      )
    )
  }

  const cancellationDeferred = DurableDeferred.make(cancellationDeferredName, {
    success: CancellationRequestSchema
  })

  // A suspension point races its own durable operation against the reserved
  // cancellation deferred, so a cancel request wakes the execution and unwinds
  // it instead of leaving it parked forever.
  const cancellationBranch = DurableDeferred.await(cancellationDeferred).pipe(
    Effect.map((request) => ({
      type: "cancelled" as const,
      compensate: request.compensate,
      actor: request.actor
    }))
  )

  const failCancelled = (outcome: { compensate: boolean; actor?: string }) =>
    Effect.gen(function* () {
      yield* emitWorkflowEvent({
        type: "cancellation.received",
        executionId,
        compensate: outcome.compensate,
        ...(outcome.actor === undefined ? {} : { actor: outcome.actor })
      })
      // A plain failure exit: withCompensation finalizers run for compensate:
      // true. compensate: false never reaches here (the client interrupts the
      // engine directly), but failing is still the safe fallback.
      return yield* Effect.fail(new Cancelled({ compensate: outcome.compensate }))
    })

  return {
    executionId,

    run(step, rawInput) {
      const invocation = nextInvocation(counters, step.name)
      const activityName = `${step.name}#${invocation}`
      const call: OrchestrationCall = { kind: "step", name: step.name, counter: invocation }
      const input = decodeSync(step.input, rawInput)

      const execute = Effect.gen(function* () {
        const attempt = yield* Activity.CurrentAttempt
        yield* emitWorkflowEvent({
          type: "step.started",
          executionId,
          stepName: step.name,
          invocation,
          activityName,
          attempt,
          input
        })

        const contextResolver = yield* currentSecretResolver
        const resolver = getExecutionSecretResolver(executionId) ?? contextResolver
        const result = yield* Effect.tryPromise({
          try: async () => {
            const release = await acquireConcurrency(step, input)
            try {
              const executeInput = await resolveSecretRefs(input, resolver)
              const value = await step.execute(executeInput, makeStepContext(executionId, attempt))
              if (isTerminalFailure(value)) {
                throw value
              }
              return decodeSync(step.output, value)
            } finally {
              release()
            }
          },
          catch: (error) => {
            if (isTerminalFailure(error)) {
              return {
                _wfFailureType: "terminal",
                error: decodeSync(step.errors, error.error)
              } satisfies ActivityFailure
            }
            return { _wfFailureType: "transient", error } satisfies ActivityFailure
          }
        })

        yield* emitWorkflowEvent({
          type: "step.completed",
          executionId,
          stepName: step.name,
          invocation,
          activityName,
          attempt,
          result
        })

        return result
      }).pipe(
        Effect.tapError((error) =>
          emitWorkflowEvent({
            type: "step.failed",
            executionId,
            stepName: step.name,
            invocation,
            activityName,
            error: unwrapActivityFailure(error)
          })
        )
      )

      let activity: Effect.Effect<unknown, unknown, any> = Activity.make({
        name: activityName,
        success: step.output,
        error: Schema.Unknown,
        execute
      })

      activity = activity.pipe(
        Activity.retry({
          schedule: retrySchedule(step.retry),
          while: (error: unknown) =>
            isActivityFailure(error) && error._wfFailureType === "transient"
        } as any),
        Effect.mapError(unwrapActivityFailure)
      )

      if (step.compensate !== undefined) {
        activity = activity.pipe(
          wf.withCompensation((value: unknown, cause: Cause.Cause<unknown>) =>
            Effect.gen(function* () {
              yield* emitWorkflowEvent({
                type: "compensation.started",
                executionId,
                stepName: step.name,
                invocation,
                activityName,
                result: value,
                input,
                reason: cause
              })
              yield* Effect.tryPromise({
                try: () => Promise.resolve(step.compensate!(value as any, input, cause)),
                catch: (error) => new AsyncFailure(error)
              }).pipe(
                Effect.tapError((error) =>
                  emitWorkflowEvent({
                    type: "compensation.failed",
                    executionId,
                    stepName: step.name,
                    invocation,
                    activityName,
                    error: unwrapAsyncFailure(error)
                  })
                ),
                Effect.orDie
              )
              yield* emitWorkflowEvent({
                type: "compensation.completed",
                executionId,
                stepName: step.name,
                invocation,
                activityName
              })
            })
          )
        )
      }

      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      }) as Effect.Effect<any, any, any>
    },

    all(effects, options) {
      const name = options?.name ?? "all"
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const branches = effects.length
      const call: OrchestrationCall = { kind: "all", name, counter: invocation, branches }
      return Effect.gen(function* () {
        yield* recordCall(call)
        yield* emitWorkflowEvent({
          type: "all.started",
          executionId,
          name,
          invocation,
          activityName,
          branches
        })
        yield* Effect.sync(() => {
          parallelDepth++
        })
        const combined = Effect.all(effects, {
          concurrency: options?.concurrency ?? "unbounded"
        }) as Effect.Effect<any, any, any>
        return yield* combined.pipe(
            Effect.ensuring(Effect.sync(() => {
              parallelDepth--
            })),
            Effect.tap(() => emitWorkflowEvent({
              type: "all.completed",
              executionId,
              name,
              invocation,
              activityName,
              branches
            })),
            Effect.tapError((error) => emitWorkflowEvent({
              type: "all.failed",
              executionId,
              name,
              invocation,
              activityName,
              branches,
              error
            }))
          ) as Effect.Effect<any, any, any>
      }) as Effect.Effect<any, any, any>
    },

    sleep(duration, name) {
      const baseName = name ?? `sleep:${String(duration)}`
      const invocation = nextInvocation(counters, baseName)
      const sleepName = `${baseName}#${invocation}`
      const call: OrchestrationCall = { kind: "sleep", name: baseName, counter: invocation }
      return Effect.gen(function* () {
        yield* recordCall(call)
        yield* emitWorkflowEvent({
          type: "sleep.started",
          executionId,
          name: baseName,
          invocation,
          activityName: sleepName,
          duration
        })
        const outcome = (yield* raceDurable(`race:${sleepName}`, [
          // Sleeps under the engine's in-memory threshold (60s) run inside
          // an activity that holds the entity mailbox, so a cancellation
          // delivered mid-sleep is consumed at the NEXT suspension point,
          // not instantly — bounded by the threshold. Longer sleeps go
          // durable and wake immediately on cancellation.
          DurableClock.sleep({ name: sleepName, duration }).pipe(
            Effect.map(() => ({ type: "slept" as const }))
          ),
          cancellationBranch
        ])) as { type: "slept" } | { type: "cancelled"; compensate: boolean; actor?: string }
        if (outcome.type === "cancelled") {
          return yield* failCancelled(outcome)
        }
        yield* emitWorkflowEvent({
          type: "sleep.completed",
          executionId,
          name: baseName,
          invocation,
          activityName: sleepName,
          duration
        })
      }) as Effect.Effect<any, any, any>
    },

    waitForSignal(name, schema, opts) {
      const invocation = nextInvocation(counters, name)
      const waitName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "signal", name, counter: invocation }
      const payloadSchema = jsonSchemaOf(schema)

      return Effect.gen(function* () {
        yield* recordCall(call)
        // Delivery-side validation needs the schema of the wait the run is
        // parked at; replay re-registers it in a fresh process.
        registerSignalSchema(executionId, name, schema)
        yield* emitWorkflowEvent({
          type: "signal.waiting",
          executionId,
          name,
          invocation,
          activityName: waitName,
          timeout: opts?.timeout,
          ...(payloadSchema === undefined ? {} : { payloadSchema })
        })

        const deferredName = `signal:${waitName}`
        const deferred = DurableDeferred.make(deferredName, { success: schema })

        // The race winner is persisted, so the signal value crosses replay as
        // its encoded form and is re-decoded below.
        const signalBranch = DurableDeferred.await(deferred).pipe(
          Effect.map((value) => ({
            type: "signal" as const,
            encoded: encodeSync(schema, value as any)
          }))
        )
        const timeoutBranch = opts?.timeout === undefined
          ? []
          : [
              DurableClock.sleep({
                name: `signal-timeout:${waitName}`,
                duration: opts.timeout,
                inMemoryThreshold: "1 milli"
              }).pipe(Effect.map(() => ({ type: "timeout" as const })))
            ]

        const outcome = (yield* raceDurable(`race:${waitName}`, [
          signalBranch,
          ...timeoutBranch,
          cancellationBranch
        ])) as
          | { type: "signal"; encoded: unknown }
          | { type: "timeout" }
          | { type: "cancelled"; compensate: boolean; actor?: string }

        if (outcome.type === "cancelled") {
          return yield* failCancelled(outcome)
        }

        if (outcome.type === "timeout") {
          yield* emitWorkflowEvent({
            type: "signal.timeout",
            executionId,
            name,
            invocation,
            activityName: waitName,
            timeout: opts?.timeout
          })
          return { type: "timeout" } as const
        }

        const value = decodeSync(schema, outcome.encoded)
        yield* emitWorkflowEvent({
          type: "signal.received",
          executionId,
          name,
          invocation,
          activityName: waitName,
          payload: value
        })
        return { type: "signal", value } as const
      }) as Effect.Effect<any, any, any>
    },

    now() {
      const invocation = nextInvocation(counters, "now")
      const activityName = `now#${invocation}`
      const call: OrchestrationCall = { kind: "now", name: "now", counter: invocation }
      const activity = Activity.make({
        name: activityName,
        success: Schema.Date,
        execute: Effect.sync(() => new Date())
      })
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      })
    },

    random() {
      const invocation = nextInvocation(counters, "random")
      const activityName = `random#${invocation}`
      const call: OrchestrationCall = { kind: "random", name: "random", counter: invocation }
      const activity = Activity.make({
        name: activityName,
        success: Schema.Number,
        execute: Effect.sync(() => Math.random())
      })
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      })
    },

    code(name, options) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "code", name, counter: invocation }
      const execute = Effect.gen(function* () {
        yield* emitWorkflowEvent({
          type: "code.started",
          executionId,
          name,
          invocation,
          activityName,
          ...(options.reason === undefined ? {} : { reason: options.reason })
        })
        const result = yield* Effect.tryPromise({
          try: async () => options.run(),
          catch: (error) => new AsyncFailure(error)
        })
        yield* emitWorkflowEvent({
          type: "code.completed",
          executionId,
          name,
          invocation,
          activityName,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
          result
        })
        return result
      }).pipe(
        Effect.tapError((error) =>
          emitWorkflowEvent({
            type: "code.failed",
            executionId,
            name,
            invocation,
            activityName,
            ...(options.reason === undefined ? {} : { reason: options.reason }),
            error: unwrapAsyncFailure(error)
          })
        )
      )
      const activity = Activity.make({
        name: activityName,
        success: Schema.Unknown,
        error: Schema.Unknown,
        execute
      }).pipe(Effect.mapError(unwrapAsyncFailure))
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      }) as Effect.Effect<any, any, any>
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect as Effect.Effect<any, any, any>
    }
  }
}

const makeInMemoryCtx = <WErrors>(
  executionId: ExecutionId,
  workflowErrors: AnySchema<WErrors>,
  compensations: CompensationEntry[],
  determinism: InMemoryDeterminismState,
  emit: (event: WorkflowEvent) => Promise<void>,
  options: Pick<
    InMemoryExecutionOptions,
    "stepExecutors" | "stepExecutor" | "sleep" | "signalTimeout" | "signalValue" | "secrets"
  > = {}
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let blockPosition = 0
  const branchCollectors: Array<OrchestrationCall[]> = []

  const recordCall = async (actual: OrchestrationCall): Promise<void> => {
    const index = journalPosition++
    const expected = determinism.calls[index]
    if (expected === undefined) {
      determinism.calls.push(actual)
    } else {
      verifyCall(expected, actual)
    }
    branchCollectors[branchCollectors.length - 1]?.push(actual)
  }

  return {
    executionId,

    run(step, rawInput) {
      const invocation = nextInvocation(counters, step.name)
      const activityName = `${step.name}#${invocation}`
      const input = decodeSync(step.input, rawInput)
      return Effect.tryPromise({
        try: async () => {
          await recordCall({ kind: "step", name: step.name, counter: invocation })
          const attempts = transientAttempts(step.retry)
          let lastTransient: unknown

          for (let attempt = 1; attempt <= attempts; attempt++) {
            await emit({
              type: "step.started",
              executionId,
              stepName: step.name,
              invocation,
              activityName,
              attempt,
              input
            })

            try {
              const stepContext = makeStepContext(executionId, attempt)
              const executeStep = options.stepExecutors?.get(step)
              const release = await acquireConcurrency(step, input)
              try {
                const executeInput = await resolveSecretRefs(input, options.secrets)
                const value = await (
                  options.stepExecutor?.({ step, input: executeInput, invocation, activityName, context: stepContext }) ??
                  executeStep?.(executeInput, stepContext as any) ??
                  step.execute(executeInput, stepContext as any)
                )
                if (isTerminalFailure(value)) {
                  const terminal = decodeSync(step.errors, value.error)
                  throw terminal
                }

                const result = decodeSync(step.output, value)
                encodeSync(step.output, result)
                await emit({
                  type: "step.completed",
                  executionId,
                  stepName: step.name,
                  invocation,
                  activityName,
                  attempt,
                  result
                })

                if (step.compensate !== undefined) {
                  compensations.push({
                    stepName: step.name,
                    invocation,
                    result,
                    input,
                    compensate: step.compensate as CompensationEntry["compensate"]
                  })
                }

                return result
              } finally {
                release()
              }
            } catch (error) {
              if (attempt === attempts || isDeclaredTerminal(step.errors, error)) {
                await emit({
                  type: "step.failed",
                  executionId,
                  stepName: step.name,
                  invocation,
                  activityName,
                  error
                })
                throw error
              }
              lastTransient = error
            }
          }

          throw lastTransient
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    sleep(duration, name) {
      const baseName = name ?? `sleep:${String(duration)}`
      const invocation = nextInvocation(counters, baseName)
      const activityName = `${baseName}#${invocation}`
      return Effect.promise(async () => {
        await recordCall({ kind: "sleep", name: baseName, counter: invocation })
        await emit({
          type: "sleep.started",
          executionId,
          name: baseName,
          invocation,
          activityName,
          duration
        })
        await options.sleep?.({ executionId, name: activityName, duration })
        await emit({
          type: "sleep.completed",
          executionId,
          name: baseName,
          invocation,
          activityName,
          duration
        })
      })
    },

    waitForSignal(name, schema, opts) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const payloadSchema = jsonSchemaOf(schema)
      return Effect.tryPromise({
        try: async () => {
          await recordCall({ kind: "signal", name, counter: invocation })
          registerSignalSchema(executionId, name, schema)
          await emit({
            type: "signal.waiting",
            executionId,
            name,
            invocation,
            activityName,
            timeout: opts?.timeout,
            ...(payloadSchema === undefined ? {} : { payloadSchema })
          })

          const buffered = takeBufferedSignal(executionId, name, schema)
          if (buffered !== undefined) {
            await emit({
              type: "signal.received",
              executionId,
              name,
              invocation,
              activityName,
              payload: buffered
            })
            return { type: "signal", value: buffered } as const
          }

          if (options.signalValue !== undefined) {
            const value = decodeSync(schema, await options.signalValue({ executionId, name, schema }))
            await emit({
              type: "signal.received",
              executionId,
              name,
              invocation,
              activityName,
              payload: value
            })
            return { type: "signal", value } as const
          }

          if (opts?.timeout !== undefined) {
            if (options.signalTimeout !== undefined) {
              const outcome = await Promise.race([
                awaitSignal(executionId, name, schema).then((value) => ({ type: "signal", value }) as const),
                options.signalTimeout({ executionId, name: activityName, duration: opts.timeout })
                  .then(() => ({ type: "timeout" }) as const)
              ])
              if (outcome.type === "signal") {
                await emit({
                  type: "signal.received",
                  executionId,
                  name,
                  invocation,
                  activityName,
                  payload: outcome.value
                })
              } else {
                await emit({
                  type: "signal.timeout",
                  executionId,
                  name,
                  invocation,
                  activityName,
                  timeout: opts.timeout
                })
              }
              return outcome
            }
            await emit({
              type: "signal.timeout",
              executionId,
              name,
              invocation,
              activityName,
              timeout: opts.timeout
            })
            return { type: "timeout" } as const
          }

          const value = await awaitSignal(executionId, name, schema)
          await emit({
            type: "signal.received",
            executionId,
            name,
            invocation,
            activityName,
            payload: value
          })
          return { type: "signal", value } as const
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    now() {
      const invocation = nextInvocation(counters, "now")
      const call: OrchestrationCall = { kind: "now", name: "now", counter: invocation }
      return Effect.promise(async () => {
        await recordCall(call)
        const key = valueKey(call)
        const existing = determinism.values.get(key)
        if (existing instanceof Date) {
          return existing
        }
        const value = new Date()
        determinism.values.set(key, value)
        return value
      })
    },

    random() {
      const invocation = nextInvocation(counters, "random")
      const call: OrchestrationCall = { kind: "random", name: "random", counter: invocation }
      return Effect.promise(async () => {
        await recordCall(call)
        const key = valueKey(call)
        const existing = determinism.values.get(key)
        if (typeof existing === "number") {
          return existing
        }
        const value = Math.random()
        determinism.values.set(key, value)
        return value
      })
    },

    code(name, options) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "code", name, counter: invocation }
      return Effect.tryPromise({
        try: async () => {
          await recordCall(call)
          await emit({
            type: "code.started",
            executionId,
            name,
            invocation,
            activityName,
            ...(options.reason === undefined ? {} : { reason: options.reason })
          })

          const key = valueKey(call)
          if (determinism.values.has(key)) {
            const result = determinism.values.get(key)
            await emit({
              type: "code.completed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              result
            })
            return result as Awaited<ReturnType<typeof options.run>>
          }

          try {
            const result = await options.run()
            determinism.values.set(key, result)
            await emit({
              type: "code.completed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              result
            })
            return result
          } catch (error) {
            await emit({
              type: "code.failed",
              executionId,
              name,
              invocation,
              activityName,
              ...(options.reason === undefined ? {} : { reason: options.reason }),
              error
            })
            throw error
          }
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as Effect.Effect<any, any, any>
    },

    all(effects, options) {
      const name = options?.name ?? "all"
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const branches = effects.length
      const call: OrchestrationCall = { kind: "all", name, counter: invocation, branches }
      const record = Effect.tryPromise({
        try: () => recordCall(call),
        catch: (error): NonDeterminismError => error as NonDeterminismError
      })
      const emitEvent = (event: WorkflowEvent) => Effect.promise(() => emit(event))
      const persistBlock = (branchCalls: OrchestrationCall[][]) =>
        Effect.sync(() => {
          if (determinism.blocks[blockPosition++] === undefined) {
            determinism.blocks.push({ call, branches: branchCalls })
          }
        })
      return Effect.gen(function* () {
        yield* record
        yield* emitEvent({
          type: "all.started",
          executionId,
          name,
          invocation,
          activityName,
          branches
        })
        const branchCalls: OrchestrationCall[][] = []
        const wrapped = effects.map((effect) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const calls: OrchestrationCall[] = []
              branchCalls.push(calls)
              branchCollectors.push(calls)
            }),
            () => effect as Effect.Effect<any, any, any>,
            () => Effect.sync(() => {
              branchCollectors.pop()
            })
          )
        )
        return yield* (Effect.all(wrapped, { concurrency: 1 }) as Effect.Effect<any, any, any>).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* persistBlock(branchCalls)
              yield* emitEvent({
                type: "all.completed",
                executionId,
                name,
                invocation,
                activityName,
                branches
              })
            })
          ),
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* persistBlock(branchCalls)
              yield* emitEvent({
                type: "all.failed",
                executionId,
                name,
                invocation,
                activityName,
                branches,
                error
              })
            })
          )
        )
      }) as Effect.Effect<any, any, any>
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect as Effect.Effect<any, any, any>
    }
  }
}

const isDeclaredTerminal = <E>(schema: AnySchema<E>, error: unknown): boolean => {
  try {
    decodeSync(schema, error)
    return true
  } catch {
    return false
  }
}

export const defineWorkflow = <
  const Input extends AnySchema,
  const Output extends AnySchema,
  const Errors extends AnySchema = typeof Schema.Never
>(config: {
  readonly name: string
  readonly version: number
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly run: (
    input: Schema.Schema.Type<Input>,
    ctx: WorkflowContext<Schema.Schema.Type<Errors>>
  ) => Generator<any, Schema.Schema.Type<Output>, any>
}): DefinedWorkflow<Schema.Schema.Type<Input>, Schema.Schema.Type<Output>, Schema.Schema.Type<Errors>> => {
  const errors = config.errors ?? Schema.Never
  const engineName = `${config.name}@v${config.version}`
  const sourceHash = createHash("sha256")
    .update(config.name)
    .update("\0")
    .update(String(config.version))
    .update("\0")
    .update(config.run.toString())
    .digest("hex")

  const workflow = Workflow.make(engineName, {
    payload: config.input as any,
    idempotencyKey: (payload: any) => JSON.stringify(payload),
    success: config.output,
    error: Schema.Unknown
  })

  const layer = workflow.toLayer(
    Effect.fn(function* (payload: Schema.Schema.Type<Input>, executionId: string) {
      const input = decodeSync(config.input, payload)
      const result = yield* config.run(input, makeCtx(workflow, ExecutionId.make(executionId), errors)) as any
      return decodeSync(config.output, result)
    }) as any
  )

  const executeInMemory = async (
    payload: Schema.Schema.Type<Input>,
    options: InMemoryExecutionOptions = {}
  ): Promise<Schema.Schema.Type<Output>> => {
    const executionId = ExecutionId.make(options.executionId ?? `memory-${crypto.randomUUID()}`)
    const compensations: CompensationEntry[] = []
    const determinism = options.determinism ?? createInMemoryDeterminismState()
    const input = decodeSync(config.input, payload)
    const emit = async (event: WorkflowEvent) => {
      await options.onEvent?.(event)
    }
    const ctx = makeInMemoryCtx(executionId, errors, compensations, determinism, emit, {
      ...(options.stepExecutors === undefined ? {} : { stepExecutors: options.stepExecutors }),
      ...(options.stepExecutor === undefined ? {} : { stepExecutor: options.stepExecutor }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.signalTimeout === undefined ? {} : { signalTimeout: options.signalTimeout }),
      ...(options.signalValue === undefined ? {} : { signalValue: options.signalValue }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets })
    })

    const effect = Effect.gen(function* () {
      return yield* config.run(input, ctx) as any
    }).pipe(
      Effect.map((result) => decodeSync(config.output, result)),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (skipsCompensation(error)) {
            return yield* Effect.fail(error)
          }
          for (const compensation of compensations.slice().reverse()) {
            yield* emitWorkflowEvent({
              type: "compensation.started",
              executionId,
              stepName: compensation.stepName,
              invocation: compensation.invocation,
              activityName: `${compensation.stepName}#${compensation.invocation}`,
              result: compensation.result,
              input: compensation.input,
              reason: error
            })
            yield* Effect.promise(() =>
              Promise.resolve(
                compensation.compensate(compensation.result, compensation.input, error)
              )
            ).pipe(
              Effect.tapError((compensationError) =>
                emitWorkflowEvent({
                  type: "compensation.failed",
                  executionId,
                  stepName: compensation.stepName,
                  invocation: compensation.invocation,
                  activityName: `${compensation.stepName}#${compensation.invocation}`,
                  error: compensationError
                })
              ),
              Effect.orDie
            )
            yield* emitWorkflowEvent({
              type: "compensation.completed",
              executionId,
              stepName: compensation.stepName,
              invocation: compensation.invocation,
              activityName: `${compensation.stepName}#${compensation.invocation}`
            })
          }
          return yield* Effect.fail(error)
        })
      )
    )

    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provideService(
          currentWorkflowEventSink,
          options.onEvent as any
        )
      ) as Effect.Effect<Schema.Schema.Type<Output>, unknown, never>
    )
    if (Exit.isSuccess(exit)) {
      return exit.value
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
    throw failure ?? Cause.squash(exit.cause)
  }

  return {
    [DefinedWorkflowTypeId]: DefinedWorkflowTypeId,
    name: config.name,
    version: config.version,
    engineName,
    sourceHash,
    input: config.input,
    output: config.output,
    errors,
    workflow,
    layer,
    execute: (payload) =>
      workflow.execute(payload as any) as Effect.Effect<
        Schema.Schema.Type<Output>,
        Schema.Schema.Type<Errors> | unknown,
        any
      >,
    executeInMemory
  }
}
