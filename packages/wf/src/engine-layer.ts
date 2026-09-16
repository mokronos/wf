import { Effect, FileSystem, Layer, Path } from "effect"
import { ClusterWorkflowEngine, SingleRunner } from "effect/unstable/cluster"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SqlClient } from "effect/unstable/sql"

/** Builds the durable workflow-engine infrastructure. Filesystem and database
 * setup stay lazy inside the layer so importing the workflow runtime is pure. */
export const engineLayer = (options: {
  readonly databasePath?: string
  readonly sqliteBusyTimeoutMs?: number
  readonly timerPollIntervalMs?: number
} = {}) => {
  const sqliteBusyTimeoutMs = Math.max(0, Math.trunc(options.sqliteBusyTimeoutMs ?? 5000))
  // The cluster default is 10 seconds, which delays every durable timer
  // (signal timeout, long sleep) by up to that long on a single-node engine.
  const timerPollIntervalMs = Math.max(10, Math.trunc(options.timerPollIntervalMs ?? 250))

  const sqliteLayer = Layer.unwrap(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const filename = path.resolve(
      options.databasePath ?? path.join(process.cwd(), ".wf", "engine.sqlite")
    )
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true })
    return SqliteClient.layer({ filename })
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
