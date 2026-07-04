#!/usr/bin/env bun
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunContext from "@effect/platform-bun/BunContext"
import * as Args from "@effect/cli/Args"
import * as Command from "@effect/cli/Command"
import * as Options from "@effect/cli/Options"
import { Console, Effect, Option } from "effect"
import { discover } from "wf"
import type { IntegrationKind, IntegrationSearchResult } from "wf"

const kind = Options.choice("kind", ["mcp", "openapi", "graphql", "cli"] as const).pipe(
  Options.optional,
  Options.withDescription("Limit results to one integration surface kind")
)

const limit = Options.integer("limit").pipe(
  Options.withDefault(20),
  Options.withDescription("Maximum number of results to return")
)

const searchTerm = Args.text({ name: "search_term" }).pipe(
  Args.withDescription("Service, domain, or integration capability to search for")
)

const formatKinds = (kinds: ReadonlyArray<IntegrationKind>): string => kinds.join(", ")

const formatResult = (result: IntegrationSearchResult): string =>
  `${result.domain}\t${formatKinds(result.kinds)}\t${result.description}\t${result.url}`

const discoverCommand = Command.make(
  "discover",
  { kind, limit, searchTerm },
  ({ kind, limit, searchTerm }) =>
    Effect.tryPromise({
      try: () => discover(searchTerm, { kind: Option.getOrUndefined(kind), limit }),
      catch: (error) => error
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

Command.run(app, { name: "integrations", version: "0.0.0" })(process.argv).pipe(
  Effect.provide(BunContext.layer),
  BunRuntime.runMain
)
