import { Schema } from "effect"
import type { Step, StepRetryPolicy } from "./core.ts"
import { IntegrationToolAddress } from "./workflow-model.ts"
export type { IntegrationInvoker } from "./integration-invoker.ts"

export const IntegrationSource = Schema.Struct({
  kind: Schema.Literal("executor"),
  address: IntegrationToolAddress
})
export type IntegrationSource = typeof IntegrationSource.Type

export class IntegrationError extends Schema.TaggedErrorClass<IntegrationError>()("IntegrationError", {
  message: Schema.String,
  address: Schema.String
}) {}

const IntegrationErrorSchema = IntegrationError
const Json = Schema.Json

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): Step<I, O, IntegrationError> => {
  const source = Schema.decodeUnknownSync(IntegrationSource)(config.source)
  return {
    name: config.name ?? `Integration:${source.address}`,
    input: config.input,
    output: config.output,
    errors: IntegrationErrorSchema,
    integration: { address: source.address },
    ...(config.retry === undefined ? {} : { retry: config.retry }),
    execute: async (input, step) => {
      try {
        const jsonInput = Schema.decodeUnknownSync(Json)(input)
        const result = await step.invokeIntegration(source.address, jsonInput)
        return await Schema.decodeUnknownPromise(config.output)(result)
      } catch (cause) {
        throw new IntegrationError({
          message: cause instanceof Error ? cause.message : String(cause),
          address: source.address
        })
      }
    }
  }
}
