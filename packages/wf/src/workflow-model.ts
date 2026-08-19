import { whenPresent } from "./optional.ts"
import { Cause, Effect, Predicate, Schema } from "effect"
import type * as Duration from "effect/Duration"
import { Cancelled } from "./cancellation.ts"
import type { StepConcurrencyPolicy } from "./concurrency.ts"
import { NonDeterminismError } from "./determinism.ts"
import { CodeExecutionError, StepExecutionError } from "./execution-errors.ts"
import type { SecretResolutionContext } from "./secrets.ts"
import { SignalDeliveryError } from "./signal.ts"
import type { IntegrationSource } from "./integration-contract.ts"

export type DynamicService = Schema.Schema.Type<Schema.Top>
export type SynchronousSchema<A> = Schema.Codec<A, DynamicService, never, never>

export {
  formatIntegrationSource,
  integrationSourceKey,
  IntegrationSource
} from "./integration-contract.ts"

const TerminalFailureTypeId: unique symbol = Symbol.for("wf/TerminalFailure")

export interface TerminalFailure<E> {
  readonly [TerminalFailureTypeId]: typeof TerminalFailureTypeId
  readonly error: E
}

export interface StepExecutionContext {
  resolveSecret(name: string, context?: SecretResolutionContext): Promise<string>
  readonly attempt: number
  readonly executionId: string
}

export interface StepContext<E> extends StepExecutionContext {
  fail(error: E): TerminalFailure<E>
}

export const terminalFailure = <E>(error: E): TerminalFailure<E> => ({
  [TerminalFailureTypeId]: TerminalFailureTypeId,
  error
})

// A type guard's input has to be wider than the type it proves, so unknown is
// the correct parameter type for one.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const isTerminalFailure = <E>(value: unknown): value is TerminalFailure<E> =>
  Predicate.isObjectOrArray(value) &&
  TerminalFailureTypeId in value &&
  value[TerminalFailureTypeId] === TerminalFailureTypeId

export const StepRetryPolicy = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThan(0)),
  backoff: Schema.Literals(["exponential", "none"])
})
export type StepRetryPolicy = typeof StepRetryPolicy.Type

export type StepConcurrency<I> = StepConcurrencyPolicy<I>

interface StepDefinition<
  Input extends SynchronousSchema<DynamicService>,
  Output extends SynchronousSchema<DynamicService>,
  Errors extends SynchronousSchema<DynamicService>
> {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors: Errors
  /** `reason` is the failure that triggered compensation, as a Cause, so a
   *  compensation can tell an ordinary failure from a defect or an interrupt.
   *  The return value is discarded: compensation succeeds or it fails. */
  readonly compensate?: (
    result: Output["Type"],
    input: Input["Type"],
    reason: Cause.Cause<unknown>
  ) => void | Promise<void>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<Input["Type"]>
}

export interface DefinedLocalStep<
  Input extends SynchronousSchema<DynamicService>,
  Output extends SynchronousSchema<DynamicService>,
  Errors extends SynchronousSchema<DynamicService>
> extends StepDefinition<Input, Output, Errors> {
  readonly kind: "local"
  readonly execute: (
    input: Input["Type"],
    step: StepContext<Errors["Type"]>
  ) => Promise<Output["Type"] | TerminalFailure<Errors["Type"]>>
}

export interface DefinedIntegrationStep<
  Input extends SynchronousSchema<DynamicService>,
  Output extends SynchronousSchema<DynamicService>,
  Errors extends SynchronousSchema<DynamicService>
> extends StepDefinition<Input, Output, Errors> {
  readonly kind: "integration"
  readonly source: IntegrationSource
}

export type DefinedStep<
  Input extends SynchronousSchema<DynamicService>,
  Output extends SynchronousSchema<DynamicService>,
  Errors extends SynchronousSchema<DynamicService>
> = DefinedLocalStep<Input, Output, Errors> | DefinedIntegrationStep<Input, Output, Errors>

export type Step<I, O, E = never> = DefinedStep<
  SynchronousSchema<I>,
  SynchronousSchema<O>,
  SynchronousSchema<E>
>

export const defineStep = <
  const Input extends SynchronousSchema<DynamicService>,
  const Output extends SynchronousSchema<DynamicService>,
  const Errors extends SynchronousSchema<DynamicService> = typeof Schema.Never
>(config: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly errors?: Errors
  readonly execute: (
    input: Input["Type"],
    step: StepContext<Errors["Type"]>
  ) => Promise<Output["Type"] | TerminalFailure<Errors["Type"]>>
  /** `reason` is the failure that triggered compensation, as a Cause, so a
   *  compensation can tell an ordinary failure from a defect or an interrupt.
   *  The return value is discarded: compensation succeeds or it fails. */
  readonly compensate?: (
    result: Output["Type"],
    input: Input["Type"],
    reason: Cause.Cause<unknown>
  ) => void | Promise<void>
  readonly retry?: StepRetryPolicy
  readonly concurrency?: StepConcurrency<Input["Type"]>
}): DefinedLocalStep<Input, Output, Errors | typeof Schema.Never> => {
  const retry = config.retry === undefined
    ? undefined
    : Schema.decodeUnknownSync(StepRetryPolicy)(config.retry)
  return {
    ...config,
    kind: "local",
    errors: config.errors ?? Schema.Never,
    ...whenPresent("retry", retry)
  }
}

export type WorkflowValue<A, E = never> = Effect.Effect<A, E, DynamicService>
export type WorkflowGenerator<O> = Generator<
  WorkflowValue<DynamicService, DynamicService>,
  O,
  DynamicService
>

type WorkflowValueSuccess<EffectValue> =
  EffectValue extends WorkflowValue<infer A, DynamicService> ? A : never

type WorkflowValueError<EffectValue> =
  EffectValue extends WorkflowValue<DynamicService, infer E> ? E : never

export type WorkflowAllSuccess<
  Effects extends ReadonlyArray<WorkflowValue<DynamicService, DynamicService>>
> = { -readonly [K in keyof Effects]: WorkflowValueSuccess<Effects[K]> }

export type WorkflowAllError<
  Effects extends ReadonlyArray<WorkflowValue<DynamicService, DynamicService>>
> = WorkflowValueError<Effects[number]>

export type SignalOutcome<T> =
  | { readonly type: "signal"; readonly value: T }
  | { readonly type: "timeout" }

export interface WorkflowContext<WErrors> {
  readonly executionId: string
  run<
    Input extends SynchronousSchema<DynamicService>,
    Output extends SynchronousSchema<DynamicService>,
    Errors extends SynchronousSchema<DynamicService>
  >(
    step: DefinedStep<Input, Output, Errors>,
    input: Input["Type"]
  ): WorkflowValue<
    Output["Type"],
    Errors["Type"] | NonDeterminismError | StepExecutionError
  >
  sleep(
    duration: Duration.Input,
    name?: string
  ): WorkflowValue<void, NonDeterminismError | Cancelled>
  waitForSignal<T>(
    name: string,
    schema: SynchronousSchema<T>,
    opts?: { readonly timeout?: Duration.Input }
  ): WorkflowValue<
    SignalOutcome<T>,
    NonDeterminismError | SignalDeliveryError | Cancelled
  >
  now(): WorkflowValue<Date, NonDeterminismError>
  random(): WorkflowValue<number, NonDeterminismError>
  code<Output extends SynchronousSchema<DynamicService>>(name: string, options: {
    readonly reason?: string
    readonly output: Output
    readonly run: () => Output["Type"] | Promise<Output["Type"]>
  }): WorkflowValue<Output["Type"], NonDeterminismError | CodeExecutionError>
  all<const Effects extends ReadonlyArray<WorkflowValue<DynamicService, DynamicService>>>(
    effects: Effects,
    options?: { readonly name?: string; readonly concurrency?: number | "unbounded" }
  ): WorkflowValue<WorkflowAllSuccess<Effects>, WorkflowAllError<Effects> | NonDeterminismError>
  fail(error: WErrors): WorkflowValue<never, WErrors>
  effect<A, E>(effect: Effect.Effect<A, E, never>): WorkflowValue<A, E>
}
