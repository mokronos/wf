import { createHash } from "node:crypto"
import { Activity, DurableClock, DurableDeferred, Workflow, WorkflowEngine } from "effect/unstable/workflow"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Duration from "effect/Duration"
import { emitWorkflowEvent } from "./events.ts"
import type { IntegrationInvoker } from "./integration-invoker.ts"
import {
  ExecutionResourceRegistry,
  makeExecutionResourceRegistry
} from "./execution-resources.ts"
import type { WorkflowEvent } from "./schemas.ts"
import { ExecutionId, jsonSchemaOf } from "./schemas.ts"
import {
  defaultSignalTransport,
  SignalDeliveryError
} from "./signal.ts"
import type { SignalTransport } from "./signal.ts"
import { defaultConcurrencyLimiter } from "./concurrency.ts"
import type { ConcurrencyLimiter } from "./concurrency.ts"
import {
  Cancelled,
  CancellationRequest,
  cancellationDeferredName,
  skipsCompensation
} from "./cancellation.ts"
export { Cancelled, cancellationDeferredName } from "./cancellation.ts"
import {
  createInMemoryDeterminismState,
  NonDeterminismError,
  OrchestrationCall,
  orchestrationCallsEqual,
  orchestrationValueKey,
  verifyOrchestrationCall
} from "./determinism.ts"
import type { InMemoryDeterminismState } from "./determinism.ts"
import { isTerminalFailure, StepRetryPolicy, terminalFailure } from "./workflow-model.ts"
import type {
  DefinedStep,
  DynamicService,
  StepContext,
  StepExecutionContext,
  SignalOutcome,
  StepIntegrationRequirement,
  SynchronousSchema,
  WorkflowAllError,
  WorkflowAllSuccess,
  WorkflowContext,
  WorkflowGenerator,
  WorkflowValue
} from "./workflow-model.ts"
export { defineStep, StepRetryPolicy, terminalFailure } from "./workflow-model.ts"
export type {
  DefinedStep,
  Step,
  StepConcurrency,
  StepContext,
  StepExecutionContext,
  SignalOutcome,
  StepIntegrationRequirement,
  SynchronousSchema,
  TerminalFailure,
  WorkflowContext,
  WorkflowGenerator,
  WorkflowValue
} from "./workflow-model.ts"
import { CodeExecutionError, StepExecutionError } from "./execution-errors.ts"
export { CodeExecutionError, StepExecutionError } from "./execution-errors.ts"
export {
  createInMemoryDeterminismState,
  NonDeterminismError,
  OrchestrationCall,
  OrchestrationKind
} from "./determinism.ts"
export type { InMemoryDeterminismState } from "./determinism.ts"
import {
  resolveSecretReferences
} from "./secrets.ts"
import type { SecretResolver } from "./secrets.ts"
export {
  envSecretResolver,
  isSecretRef,
  secret,
  SecretRef,
  SecretResolutionContext
} from "./secrets.ts"
export type { SecretResolver } from "./secrets.ts"

type DynamicEffect = Effect.Effect<DynamicService, DynamicService, DynamicService>
interface WorkflowCompensator {
  readonly withCompensation: (
    compensation: (
      value: DynamicService,
      cause: Cause.Cause<DynamicService>
    ) => Effect.Effect<void, never, DynamicService>
  ) => (effect: DynamicEffect) => DynamicEffect
}
// Durable RPC messages are JSON encoded, so represent `undefined` explicitly
// instead of placing it in an object property that serialization would omit.
const WorkflowPayloadSchema = Schema.Struct({
  type: Schema.Literals(["value", "void"]),
  value: Schema.Unknown
})
type WorkflowPayload = typeof WorkflowPayloadSchema.Type

const encodeWorkflowPayload = (value: DynamicService): WorkflowPayload =>
  value === undefined ? { type: "void", value: null } : { type: "value", value }

const decodeWorkflowPayload = (payload: WorkflowPayload): DynamicService =>
  payload.type === "void" ? undefined : payload.value

export const DefinedWorkflowTypeId = Symbol.for("wf/DefinedWorkflow")

export interface WorkflowEngineHandle {
  readonly name: string
  readonly execute: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    executionId: string,
    payload: DynamicService
  ) => Effect.Effect<DynamicService, DynamicService>
  readonly executeStandalone: (
    payload: DynamicService
  ) => Effect.Effect<
    DynamicService,
    DynamicService,
    WorkflowEngine.WorkflowEngine
  >
  readonly resume: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    executionId: string
  ) => Effect.Effect<void>
  readonly interrupt: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    executionId: string
  ) => Effect.Effect<void>
}

export interface WorkflowDefinition<
  Input extends SynchronousSchema<DynamicService>,
  Output extends SynchronousSchema<DynamicService>,
  Errors extends SynchronousSchema<DynamicService>
> {
  readonly [DefinedWorkflowTypeId]: typeof DefinedWorkflowTypeId
  readonly name: string
  readonly sourceHash: string
  readonly input: Input
  readonly output: Output
  readonly errors: Errors
  readonly workflow: WorkflowEngineHandle
  readonly layer: Layer.Layer<
    never,
    never,
    WorkflowEngine.WorkflowEngine | ExecutionResourceRegistry
  >
  execute(payload: Input["Type"]): Effect.Effect<
    Output["Type"],
    Errors["Type"] | unknown,
    WorkflowEngine.WorkflowEngine
  >
  executeInMemory(
    payload: Input["Type"],
    options?: InMemoryExecutionOptions
  ): Promise<Output["Type"]>
}

export type DefinedWorkflow<
  I = DynamicService,
  O = DynamicService,
  WErrors = DynamicService
> = WorkflowDefinition<
  SynchronousSchema<I>,
  SynchronousSchema<O>,
  SynchronousSchema<WErrors>
>

export interface InMemoryExecutionOptions {
  readonly executionId?: string
  readonly signal?: AbortSignal
  readonly determinism?: InMemoryDeterminismState
  readonly onEvent?: (event: WorkflowEvent) => void | Promise<void>
  readonly stepExecutor?: (options: {
    readonly step: InspectableStep
    readonly input: unknown
    readonly invocation: number
    readonly activityName: string
    readonly context: StepExecutionContext
  }) => StepExecutionOverride | Promise<StepExecutionOverride>
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
    readonly schema: SynchronousSchema<DynamicService>
  }) => unknown | Promise<unknown>
  /** Execution-scoped signal adapter. Defaults to the legacy singleton. */
  readonly signalTransport?: SignalTransport
  readonly secrets?: SecretResolver
  readonly integrations?: IntegrationInvoker
  readonly concurrency?: ConcurrencyLimiter
}

export interface InspectableStep {
  readonly name: string
  readonly input: Schema.Top
  readonly output: Schema.Top
  readonly errors: Schema.Top
  readonly retry?: StepRetryPolicy
  readonly concurrency?: { readonly limit: number; readonly key?: object }
  readonly compensate?: object
  readonly integration?: StepIntegrationRequirement
}

export type StepExecutionOverride =
  | { readonly handled: false }
  | { readonly handled: true; readonly value: unknown }

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

const isActivityFailure = (value: unknown): value is ActivityFailure =>
  typeof value === "object" &&
  value !== null &&
  "_wfFailureType" in value &&
  (value._wfFailureType === "terminal" || value._wfFailureType === "transient")

const unwrapActivityFailure = (error: unknown): unknown =>
  isActivityFailure(error) ? error.error : error

const typedStepFailure = (stepName: string, error: unknown): unknown =>
  isActivityFailure(error) && error._wfFailureType === "terminal"
    ? error.error
    : new StepExecutionError({
        stepName,
        cause: isActivityFailure(error) ? error.error : error
      })

const unwrapAsyncFailure = (error: unknown): unknown =>
  error instanceof AsyncFailure ? error.error : error

const preserveNonDeterminismError = (error: unknown): NonDeterminismError => {
  if (error instanceof NonDeterminismError) return error
  throw error
}

const makeStepContext = <E>(
  _errors: SynchronousSchema<E>,
  executionId: string,
  attempt: number,
  resolver?: SecretResolver,
  integrations?: IntegrationInvoker
): StepContext<E> => ({
  attempt,
  executionId,
  fail: terminalFailure,
  resolveSecret: (name, context) => {
    if (resolver === undefined) throw new Error(`No secret resolver configured for ${name}`)
    return Promise.resolve(resolver.resolve(name, context))
  },
  invokeIntegration: (address, input) => {
    if (integrations === undefined) {
      throw new Error(`No integration invoker configured for ${address}`)
    }
    return integrations.invoke(address, input)
  }
})

const nextInvocation = (counters: Map<string, number>, name: string): number => {
  const invocation = (counters.get(name) ?? 0) + 1
  counters.set(name, invocation)
  return invocation
}

const decodeSync = <S extends SynchronousSchema<DynamicService>>(
  schema: S,
  value: unknown
): S["Type"] =>
  Schema.decodeUnknownSync(schema)(value)

const encodeSync = <S extends SynchronousSchema<DynamicService>>(
  schema: S,
  value: S["Type"]
): unknown =>
  Schema.encodeSync(schema)(value)

// Durable race with a persisted winner. This deliberately does NOT use
// DurableDeferred.raceAll: its replay path runs `Effect.flatten(exit)` over
// the stored winner, which dies with "Not a valid effect" for plain (non-
// Effect) winner values. We store/unwrap the same way DurableDeferred.await
// does — a single `yield*` of the persisted exit.
const raceDurable = (
  name: string,
  effects: readonly [
    Effect.Effect<DynamicService, DynamicService, DynamicService>,
    ...Array<Effect.Effect<DynamicService, DynamicService, DynamicService>>
  ]
): Effect.Effect<DynamicService, DynamicService, DynamicService> =>
  Effect.gen(function* () {
    const deferred = DurableDeferred.make(name, {
      success: Schema.Unknown,
      error: Schema.Unknown
    })
    const engine = yield* WorkflowEngine.WorkflowEngine
    const exit = yield* Workflow.wrapActivityResult(
      engine.deferredResult(deferred),
      Option.isNone
    )
    if (Option.isSome(exit)) {
      return yield* exit.value
    }
    return yield* DurableDeferred.into(Effect.raceAll(effects), deferred)
  })

const transientAttempts = (retry: StepRetryPolicy | undefined): number =>
  Math.max(1, retry?.attempts ?? 1)

const retryDelayMillis = (retry: StepRetryPolicy | undefined, attempt: number): number =>
  retry?.backoff === "exponential" && attempt > 1
    ? 10 * 2 ** (attempt - 2)
    : 0

const makeCtx = <WErrors>(
  wf: WorkflowCompensator,
  executionId: ExecutionId,
  workflowErrors: SynchronousSchema<WErrors>
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let parallelDepth = 0

  const recordCall = (
    actual: OrchestrationCall
  ): Effect.Effect<void, NonDeterminismError, DynamicService> => {
    const position = ++journalPosition
    const activityName = parallelDepth > 0
      ? `determinism:${actual.kind}:${actual.name}#${actual.counter}`
      : `determinism#${position}`
    return Activity.make({
      name: activityName,
      success: OrchestrationCall,
      execute: Effect.succeed(actual)
    }).pipe(
      Effect.flatMap((expected) =>
        orchestrationCallsEqual(expected, actual)
          ? Effect.void
          : Effect.fail(new NonDeterminismError({ expected, actual }))
      )
    )
  }

  const cancellationDeferred = DurableDeferred.make(cancellationDeferredName, {
    success: CancellationRequest
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
      return yield* new Cancelled({ compensate: outcome.compensate })
    })

  return {
    executionId,

    run<
      Input extends SynchronousSchema<DynamicService>,
      Output extends SynchronousSchema<DynamicService>,
      Errors extends SynchronousSchema<DynamicService>
    >(step: DefinedStep<Input, Output, Errors>, rawInput: Input["Type"]) {
      const invocation = nextInvocation(counters, step.name)
      const activityName = `${step.name}#${invocation}`
      const call: OrchestrationCall = { kind: "step", name: step.name, counter: invocation }
      const input = decodeSync(step.input, rawInput)

      const execute = Effect.gen(function* () {
        const attempt = yield* Activity.CurrentAttempt
        const retryDelay = retryDelayMillis(step.retry, attempt)
        if (retryDelay > 0) {
          yield* Effect.sleep(`${retryDelay} millis`)
        }
        yield* emitWorkflowEvent({
          type: "step.started",
          executionId,
          stepName: step.name,
          invocation,
          activityName,
          attempt,
          input
        })

        const registry = yield* ExecutionResourceRegistry
        const resources = registry.get(executionId)
        const resolver = resources.secrets
        const integrations = resources.integrations
        const result = yield* Effect.tryPromise({
          try: async () => {
            const release = await (resources.concurrency ?? defaultConcurrencyLimiter)
              .acquire(step.name, step.concurrency, input)
            try {
              const executeInput = decodeSync(
                step.input,
                await resolveSecretReferences(input, resolver)
              )
              const value = await step.execute(
                executeInput,
                makeStepContext(step.errors, executionId, attempt, resolver, integrations)
              )
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

      let activity: DynamicEffect = Activity.make({
        name: activityName,
        success: step.output,
        error: Schema.Unknown,
        execute
      })

      activity = activity.pipe(
        Activity.retry({
          times: transientAttempts(step.retry) - 1,
          while: (error: unknown) =>
            isActivityFailure(error) && error._wfFailureType === "transient"
        }),
        Effect.mapError((error) => typedStepFailure(step.name, error))
      )

      if (step.compensate !== undefined) {
        const compensate = step.compensate
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
              const result = decodeSync(step.output, value)
              yield* Effect.tryPromise({
                try: () => Promise.resolve(compensate(result, input, cause)),
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
      }) as WorkflowValue<
        Output["Type"],
        Errors["Type"] | NonDeterminismError | StepExecutionError
      >
    },

    all<const Effects extends ReadonlyArray<WorkflowValue<DynamicService, DynamicService>>>(
      effects: Effects,
      options?: { readonly name?: string; readonly concurrency?: number | "unbounded" }
    ) {
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
        }) as WorkflowValue<WorkflowAllSuccess<Effects>, WorkflowAllError<Effects>>
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
          )
      }) as WorkflowValue<
        WorkflowAllSuccess<Effects>,
        WorkflowAllError<Effects> | NonDeterminismError
      >
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
      }) as WorkflowValue<void, NonDeterminismError | Cancelled>
    },

    waitForSignal<T>(
      name: string,
      schema: SynchronousSchema<T>,
      opts?: { readonly timeout?: Duration.Input }
    ) {
      const invocation = nextInvocation(counters, name)
      const waitName = `${name}#${invocation}`
      const call: OrchestrationCall = { kind: "signal", name, counter: invocation }
      const payloadSchema = jsonSchemaOf(schema)

      return Effect.gen(function* () {
        yield* recordCall(call)
        // Delivery-side validation needs the schema of the wait the run is
        // parked at; replay re-registers it in a fresh process.
        const registry = yield* ExecutionResourceRegistry
        const resources = registry.get(executionId)
        const signals = resources.signals ?? defaultSignalTransport
        signals.registerSchema(executionId, name, schema)
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
            encoded: encodeSync(schema, value)
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
      }) as WorkflowValue<
        SignalOutcome<T>,
        NonDeterminismError | SignalDeliveryError | Cancelled
      >
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

    code<Output extends SynchronousSchema<DynamicService>>(name: string, options: {
      readonly reason?: string
      readonly output: Output
      readonly run: () => Output["Type"] | Promise<Output["Type"]>
    }) {
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
        const result = decodeSync(options.output, yield* Effect.tryPromise({
          try: async () => options.run(),
          catch: (error) => new AsyncFailure(error)
        }))
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
        success: options.output,
        error: Schema.Unknown,
        execute
      }).pipe(Effect.mapError((error) =>
        new CodeExecutionError({ name, cause: unwrapAsyncFailure(error) })
      ))
      return Effect.gen(function* () {
        yield* recordCall(call)
        return yield* activity
      }) as WorkflowValue<Output["Type"], NonDeterminismError | CodeExecutionError>
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect
    }
  }
}

const makeInMemoryCtx = <WErrors>(
  executionId: ExecutionId,
  workflowErrors: SynchronousSchema<WErrors>,
  compensations: CompensationEntry[],
  determinism: InMemoryDeterminismState,
  emit: (event: WorkflowEvent) => Promise<void>,
  options: Pick<
    InMemoryExecutionOptions,
    "signal" | "stepExecutor" | "sleep" | "signalTimeout" | "signalValue" | "signalTransport" | "secrets" | "integrations" | "concurrency"
  > = {}
): WorkflowContext<WErrors> => {
  const counters = new Map<string, number>()
  let journalPosition = 0
  let blockPosition = 0
  const branchCollectors: Array<OrchestrationCall[]> = []
  const signals = options.signalTransport ?? defaultSignalTransport

  const recordCall = async (actual: OrchestrationCall): Promise<void> => {
    const index = journalPosition++
    const expected = determinism.calls[index]
    if (expected === undefined) {
      determinism.calls.push(actual)
    } else {
      verifyOrchestrationCall(expected, actual)
    }
    branchCollectors[branchCollectors.length - 1]?.push(actual)
  }

  return {
    executionId,

    run<
      Input extends SynchronousSchema<DynamicService>,
      Output extends SynchronousSchema<DynamicService>,
      Errors extends SynchronousSchema<DynamicService>
    >(step: DefinedStep<Input, Output, Errors>, rawInput: Input["Type"]) {
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
              const stepContext = makeStepContext(
                step.errors,
                executionId,
                attempt,
                options.secrets,
                options.integrations
              )
              const release = await (options.concurrency ?? defaultConcurrencyLimiter)
                .acquire(step.name, step.concurrency, input, options.signal)
              try {
                const executeInput = decodeSync(
                  step.input,
                  await resolveSecretReferences(input, options.secrets)
                )
                const override = options.stepExecutor === undefined
                  ? { handled: false } as const
                  : await options.stepExecutor({
                      step,
                      input: executeInput,
                      invocation,
                      activityName,
                      context: stepContext
                    })
                const value = override.handled
                  ? override.value
                  : await step.execute(executeInput, stepContext)
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
                  const compensate = step.compensate
                  compensations.push({
                    stepName: step.name,
                    invocation,
                    result,
                    input,
                    compensate: (result, compensationInput, reason) => compensate(
                      decodeSync(step.output, result),
                      decodeSync(step.input, compensationInput),
                      reason
                    )
                  })
                }

                return result
              } finally {
                release()
              }
            } catch (error) {
              const terminal = isDeclaredTerminal(step.errors, error)
              if (attempt === attempts || terminal) {
                const failure = terminal
                  ? error
                  : new StepExecutionError({ stepName: step.name, cause: error })
                await emit({
                  type: "step.failed",
                  executionId,
                  stepName: step.name,
                  invocation,
                  activityName,
                  error: failure
                })
                throw failure
              }
              lastTransient = error
            }
          }

          throw lastTransient
        },
        catch: (error) => new AsyncFailure(error)
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as WorkflowValue<
        Output["Type"],
        Errors["Type"] | NonDeterminismError | StepExecutionError
      >
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

    waitForSignal<T>(
      name: string,
      schema: SynchronousSchema<T>,
      opts?: { readonly timeout?: Duration.Input }
    ) {
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const payloadSchema = jsonSchemaOf(schema)
      return Effect.tryPromise({
        try: async () => {
          await recordCall({ kind: "signal", name, counter: invocation })
          signals.registerSchema(executionId, name, schema)
          await emit({
            type: "signal.waiting",
            executionId,
            name,
            invocation,
            activityName,
            timeout: opts?.timeout,
            ...(payloadSchema === undefined ? {} : { payloadSchema })
          })

          const buffered = signals.takeBuffered(executionId, name, schema)
          if (buffered.present) {
            await emit({
              type: "signal.received",
              executionId,
              name,
              invocation,
              activityName,
              payload: buffered.value
            })
            return { type: "signal", value: buffered.value } as const
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
              const controller = new AbortController()
              const outcome = await Promise.race([
                signals.await(executionId, name, schema, { signal: controller.signal })
                  .then((value) => ({ type: "signal", value }) as const),
                options.signalTimeout({ executionId, name: activityName, duration: opts.timeout })
                  .then(() => ({ type: "timeout" }) as const)
              ]).finally(() => controller.abort())
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

          const value = await signals.await(executionId, name, schema)
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
      }).pipe(Effect.mapError(unwrapAsyncFailure)) as WorkflowValue<
        SignalOutcome<T>,
        NonDeterminismError | SignalDeliveryError | Cancelled
      >
    },

    now() {
      const invocation = nextInvocation(counters, "now")
      const call: OrchestrationCall = { kind: "now", name: "now", counter: invocation }
      return Effect.promise(async () => {
        await recordCall(call)
        const key = orchestrationValueKey(call)
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
        const key = orchestrationValueKey(call)
        const existing = determinism.values.get(key)
        if (typeof existing === "number") {
          return existing
        }
        const value = Math.random()
        determinism.values.set(key, value)
        return value
      })
    },

    code<Output extends SynchronousSchema<DynamicService>>(name: string, options: {
      readonly reason?: string
      readonly output: Output
      readonly run: () => Output["Type"] | Promise<Output["Type"]>
    }) {
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

          const key = orchestrationValueKey(call)
          if (determinism.values.has(key)) {
            const result = decodeSync(options.output, determinism.values.get(key))
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
          }

          try {
            const result = decodeSync(options.output, await options.run())
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
        catch: (cause) => new CodeExecutionError({ name, cause })
      }) as WorkflowValue<Output["Type"], NonDeterminismError | CodeExecutionError>
    },

    all<const Effects extends ReadonlyArray<WorkflowValue<DynamicService, DynamicService>>>(
      effects: Effects,
      options?: { readonly name?: string; readonly concurrency?: number | "unbounded" }
    ) {
      const name = options?.name ?? "all"
      const invocation = nextInvocation(counters, name)
      const activityName = `${name}#${invocation}`
      const branches = effects.length
      const call: OrchestrationCall = { kind: "all", name, counter: invocation, branches }
      const record = Effect.tryPromise({
        try: () => recordCall(call),
        catch: preserveNonDeterminismError
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
            () => effect,
            () => Effect.sync(() => {
              branchCollectors.pop()
            })
          )
        )
        return yield* Effect.all(wrapped, { concurrency: 1 }).pipe(
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
      }) as WorkflowValue<
        WorkflowAllSuccess<Effects>,
        WorkflowAllError<Effects> | NonDeterminismError
      >
    },

    fail(error) {
      return Effect.fail(decodeSync(workflowErrors, error))
    },

    effect(effect) {
      return effect
    }
  }
}

const isDeclaredTerminal = <E>(schema: SynchronousSchema<E>, error: unknown): boolean => {
  try {
    decodeSync(schema, error)
    return true
  } catch {
    return false
  }
}

const schemaFingerprint = (schema: Schema.Top): string =>
  JSON.stringify(jsonSchemaOf(schema) ?? { ast: schema.ast._tag })

export const defineWorkflow = <
  const Input extends SynchronousSchema<DynamicService>,
  const Output extends SynchronousSchema<DynamicService>,
  const Errors extends SynchronousSchema<DynamicService> = typeof Schema.Never
>(config: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly run: (
    input: Input["Type"],
    ctx: WorkflowContext<Errors["Type"]>
  ) => WorkflowGenerator<Output["Type"]>
}): WorkflowDefinition<
  Input,
  Output,
  Errors | typeof Schema.Never
> => {
  const errors: Errors | typeof Schema.Never = config.errors ?? Schema.Never
  const sourceHash = createHash("sha256")
    .update(config.name)
    .update("\0")
    .update(config.run.toString())
    .update("\0")
    .update(schemaFingerprint(config.input))
    .update("\0")
    .update(schemaFingerprint(config.output))
    .update("\0")
    .update(schemaFingerprint(errors))
    .digest("hex")

  const workflow = Workflow.make({
    name: config.name,
    payload: WorkflowPayloadSchema,
    idempotencyKey: (payload) => JSON.stringify(payload),
    success: config.output,
    error: Schema.Unknown
  })

  const layer = workflow.toLayer(
    Effect.fn(function* (
      payload: WorkflowPayload,
      executionId: string
    ) {
      const input = decodeSync(config.input, decodeWorkflowPayload(payload))
      const result = yield* config.run(
        input,
        makeCtx<Errors["Type"]>(
          workflow,
          ExecutionId.make(executionId),
          errors
        )
      )
      return decodeSync(config.output, result)
    })
  )

  const workflowHandle: WorkflowEngineHandle = {
    name: workflow.name,
    execute: (engine, executionId, payload) =>
      engine.execute(workflow, { executionId, payload: encodeWorkflowPayload(payload) }),
    executeStandalone: (payload) => workflow.execute(encodeWorkflowPayload(payload)),
    resume: (engine, executionId) => engine.resume(workflow, executionId),
    interrupt: (engine, executionId) => engine.interrupt(workflow, executionId)
  }

  const executeInMemory = async (
    payload: Input["Type"],
    options: InMemoryExecutionOptions = {}
  ): Promise<Output["Type"]> => {
    const executionId = ExecutionId.make(options.executionId ?? `memory-${crypto.randomUUID()}`)
    const compensations: CompensationEntry[] = []
    const determinism = options.determinism ?? createInMemoryDeterminismState()
    const input = decodeSync(config.input, payload)
    const emit = async (event: WorkflowEvent) => {
      await options.onEvent?.(event)
    }
    const ctx = makeInMemoryCtx<Errors["Type"]>(
      executionId,
      errors,
      compensations,
      determinism,
      emit,
      {
        ...(options.stepExecutor === undefined ? {} : { stepExecutor: options.stepExecutor }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.signalTimeout === undefined ? {} : { signalTimeout: options.signalTimeout }),
        ...(options.signalValue === undefined ? {} : { signalValue: options.signalValue }),
        ...(options.signalTransport === undefined ? {} : { signalTransport: options.signalTransport }),
        ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
        ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency })
      }
    )

    const effect = Effect.gen(function* () {
      return yield* config.run(input, ctx)
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

    const resources = makeExecutionResourceRegistry({
      ...(options.onEvent === undefined ? {} : { events: options.onEvent }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.integrations === undefined ? {} : { integrations: options.integrations }),
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
      ...(options.signalTransport === undefined ? {} : { signals: options.signalTransport })
    })

    const exit = await Effect.runPromiseExit(
      effect.pipe(
        Effect.provideService(ExecutionResourceRegistry, resources)
      ) as Effect.Effect<Output["Type"], unknown, never>,
      options.signal === undefined ? {} : { signal: options.signal }
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
    sourceHash,
    input: config.input,
    output: config.output,
    errors,
    workflow: workflowHandle,
    layer: layer as Layer.Layer<
      never,
      never,
      WorkflowEngine.WorkflowEngine | ExecutionResourceRegistry
    >,
    execute: (payload) => {
      return workflowHandle.executeStandalone(payload) as Effect.Effect<
        Output["Type"],
        Errors["Type"] | unknown,
        WorkflowEngine.WorkflowEngine
      >
    },
    executeInMemory
  }
}
