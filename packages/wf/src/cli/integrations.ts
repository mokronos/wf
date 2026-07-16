#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { discover } from "../index.ts"
import type { IntegrationKind, IntegrationSearchResult } from "../index.ts"

class IntegrationDiscoveryError extends Error {
  readonly _tag = "IntegrationDiscoveryError"
  readonly originalError: unknown

  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Integration discovery failed")
    this.name = "IntegrationDiscoveryError"
    this.originalError = error
  }
}

const kind = Flag.choice("kind", ["mcp", "openapi", "graphql", "cli"] as const).pipe(
  Flag.optional,
  Flag.withDescription("Limit results to one integration surface kind")
)

const limit = Flag.integer("limit").pipe(
  Flag.withDefault(20),
  Flag.withDescription("Maximum number of results to return")
)

const searchTerm = Argument.string("search_term").pipe(
  Argument.withDescription("Service, domain, or integration capability to search for")
)

const formatKinds = (kinds: ReadonlyArray<IntegrationKind>): string => kinds.join(", ")

const formatResult = (result: IntegrationSearchResult): string =>
  `${result.domain}\t${formatKinds(result.kinds)}\t${result.description}\t${result.url}`

const discoverCommand = Command.make(
  "discover",
  { kind, limit, searchTerm },
  ({ kind, limit, searchTerm }) =>
    Effect.tryPromise({
      try: () => {
        const selectedKind = Option.getOrUndefined(kind)
        return discover(searchTerm, {
          ...(selectedKind === undefined ? {} : { kind: selectedKind }),
          limit
        })
      },
      catch: (error) => new IntegrationDiscoveryError(error)
    }).pipe(
      Effect.flatMap(({ results }) =>
        Effect.gen(function* () {
          if (results.length === 0) {
            yield* Console.log("No integrations found.")
            return
          }

          for (const result of results) {
            yield* Console.log(formatResult(result))
          }
        })
      )
    )
).pipe(Command.withDescription("Search integrations.sh for agent-ready integration surfaces"))

const app = Command.make("integrations", {}).pipe(
  Command.withDescription("Discover public integration surfaces from integrations.sh"),
  Command.withSubcommands([discoverCommand] as const)
)

Command.run(app, { version: "0.0.0" }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)
