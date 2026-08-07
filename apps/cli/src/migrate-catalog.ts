import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { Schema } from "effect"
import { createDirectoryWorkflowCatalog, workflowIdFromFilename } from "@mokronos/wfkit"
import { legacyCatalogPath, workflowsPath } from "./paths.ts"

const LegacyRow = Schema.Struct({
  id: Schema.String,
  source: Schema.String
})

const decodeLegacyRows = Schema.decodeUnknownSync(Schema.Array(LegacyRow))

interface WalCheckpoint {
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
}

const readLegacyRows = async (
  legacyPath: string
): Promise<ReadonlyArray<{ readonly id: string; readonly source: string }>> => {
  const { Database } = await import("bun:sqlite")
  const database = new Database(legacyPath, { readwrite: true })
  try {
    const tables = database.query<{ readonly name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'"
    ).all()
    if (tables.length === 0) return []
    const rows = decodeLegacyRows(
      database.query<{ readonly id: string; readonly source: string }, []>(
        "SELECT id, source FROM workflows WHERE source <> ''"
      ).all()
    )
    // The catalog ran in WAL mode, so most of its content can still be sitting
    // in the -wal file. Fold it into the database itself before the file is
    // renamed, or the copy left behind for the user is an empty shell.
    const checkpoint = database.query<WalCheckpoint, []>("PRAGMA wal_checkpoint(TRUNCATE)").get()
    if (checkpoint === null || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
      throw new Error("Cannot archive the legacy catalog while its WAL checkpoint is incomplete")
    }
    return rows
  } finally {
    database.close()
  }
}

/**
 * A rename would silently overwrite its destination, so an earlier archived
 * catalog is never traded for a later one.
 */
const unusedPath = async (preferred: string): Promise<string> => {
  if (!existsSync(preferred)) return preferred
  for (let suffix = 2; suffix < 1_000; suffix++) {
    const candidate = `${preferred}.${suffix}`
    if (!existsSync(candidate)) return candidate
  }
  throw new Error(`Cannot archive the legacy catalog: ${preferred} and its numbered copies all exist`)
}

/**
 * Workflow sources used to live in a `workflows` table inside `wf.sqlite`, where
 * only the CLI could reach them. They are files now, so an older catalog is
 * unpacked into the workflows directory once and the database is set aside.
 */
export const migrateLegacyCatalog = async (home: string): Promise<ReadonlyArray<string>> => {
  const legacyPath = legacyCatalogPath(home)
  if (!existsSync(legacyPath)) return []

  const rows = await readLegacyRows(legacyPath)
  const catalog = createDirectoryWorkflowCatalog({ directory: workflowsPath(home) })
  const migrated: Array<string> = []
  for (const row of rows) {
    const id = workflowIdFromFilename(`${row.id}.ts`)
    // An id the file catalog cannot represent would need a rename to import,
    // which is the user's decision rather than a silent one taken here.
    if (id === undefined) continue
    if (await catalog.get(id) !== undefined) continue
    await catalog.write(id, row.source)
    migrated.push(id)
  }

  // Keep the old database as a copy the user can inspect, and drop the
  // write-ahead files with it so nothing reopens a half-moved catalog.
  await rename(legacyPath, await unusedPath(`${legacyPath}.migrated`))
  await Promise.all([
    rm(`${legacyPath}-wal`, { force: true }),
    rm(`${legacyPath}-shm`, { force: true })
  ])
  return migrated
}
