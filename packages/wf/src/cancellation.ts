import { Schema } from "effect"

export const cancellationDeferredName = "wf:cancel"

export const CancellationRequest = Schema.Struct({
  compensate: Schema.Boolean,
  actor: Schema.optionalKey(Schema.String)
})
export type CancellationRequest = typeof CancellationRequest.Type

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("Cancelled", {
  compensate: Schema.Boolean
}) {
  override get message(): string {
    return "Workflow execution cancelled"
  }
}

// A caught value. TypeScript types every catch binding as unknown because
// JavaScript lets any value be thrown, so there is nothing narrower to accept.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const skipsCompensation = (error: unknown): boolean =>
  error instanceof Cancelled && !error.compensate
