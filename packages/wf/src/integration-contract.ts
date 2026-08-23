import { Schema } from "effect"

/** The logical name a grant exposes a connection under.
 *
 * A workflow declares the alias it needs, the way a program declares an
 * environment variable it needs; each deployment binds that name to whatever
 * connection is right there. That is what lets one definition run for different
 * people against different connections without changing. The gateway owns the
 * deployment binding behind this portable requirement. */
export const IntegrationAlias = Schema.String.pipe(
  Schema.refine((value): value is string => /^[a-z][a-z0-9-]*$/.test(value))
)
export type IntegrationAlias = typeof IntegrationAlias.Type

/** What a workflow says about an external call: an alias and a tool, and
 * nothing else.
 *
 * Connection names, owner tiers, credentials, and resolved addresses all belong
 * to the gateway and never enter workflow source. */
export const IntegrationSource = Schema.Struct({
  kind: Schema.Literal("gateway"),
  alias: IntegrationAlias,
  tool: Schema.String
})
export type IntegrationSource = typeof IntegrationSource.Type

export const formatIntegrationSource = (source: IntegrationSource): string =>
  `${source.alias}.${source.tool}`

/** Collision-free identity for durable step names and requirement
 *  deduplication. */
export const integrationSourceKey = (source: IntegrationSource): string =>
  `gateway:${encodeURIComponent(source.alias)}:${encodeURIComponent(source.tool)}`

type JsonValue = typeof Schema.Json.Type

/** The only runtime capability workflow execution needs from an integration
 * host. Resolution, authentication, transport, and credentials stay behind it.
 *
 * Implemented over HTTP against the gateway by the composition root; the
 * authoring package never learns what is on the other side. */
export interface IntegrationInvoker {
  readonly invoke: (source: IntegrationSource, input: JsonValue) => Promise<JsonValue>
}
