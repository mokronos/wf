import { whenPresent } from "./optional.ts"
import { Schema } from "effect"
import type {
  DefinedIntegrationStep,
  StepRetryPolicy,
  SynchronousSchema
} from "./workflow-model.ts"
import { IntegrationSource } from "./integration-contract.ts"
export { IntegrationAlias, IntegrationSource } from "./integration-contract.ts"

const integrationSourceKey = (source: IntegrationSource): string =>
  `gateway:${encodeURIComponent(source.alias)}:${encodeURIComponent(source.tool)}`

export const integration = <I, O>(config: {
  readonly name?: string
  readonly source: IntegrationSource
  readonly input: Schema.Codec<I>
  readonly output: Schema.Codec<O>
  readonly retry?: StepRetryPolicy
}): DefinedIntegrationStep<
  SynchronousSchema<I>,
  SynchronousSchema<O>,
  typeof Schema.Never
> => {
  const source = Schema.decodeUnknownSync(IntegrationSource)(config.source)
  return {
    kind: "integration",
    name: config.name ?? `Integration:${integrationSourceKey(source)}`,
    input: config.input,
    output: config.output,
    errors: Schema.Never,
    source,
    ...whenPresent("retry", config.retry)
  }
}
