import { mkdirSync } from "node:fs"
import path from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqlClient } from "effect/unstable/sql"

const defaultEngineDatabasePath = (): string =>
  path.join(process.cwd(), ".wf", "engine.sqlite")

/** Builds the durable workflow-engine infrastructure. Filesystem and database
 * setup stay lazy inside the layer so importing the workflow runtime is pure. */
export const engineLayer = (options: {
  readonly databasePath?: string
  readonly sqliteBusyTimeoutMs?: number
  readonly timerPollIntervalMs?: number
} = {}) => {
  const databasePath = path.resolve(options.databasePath ?? defaultEngineDatabasePath())
  const sqliteBusyTimeoutMs = Math.max(0, Math.trunc(options.sqliteBusyTimeoutMs ?? 5000))
  // The cluster default is 10 seconds, which delays every durable timer
  // (signal timeout, long sleep) by up to that long on a single-node engine.
  const timerPollIntervalMs = Math.max(10, Math.trunc(options.timerPollIntervalMs ?? 250))
  const sqliteLayer = Layer.unwrap(Effect.sync(() => {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    return SqliteClient.layer({ filename: databasePath })
  }))
  const configuredSqliteLayer = Layer.effectDiscard(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.unsafe(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs}`)
  })).pipe(Layer.provideMerge(sqliteLayer))

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(SingleRunner.layer({
      shardingConfig: { entityMessagePollInterval: timerPollIntervalMs }
    })),
    Layer.provide(configuredSqliteLayer)
  )
}
