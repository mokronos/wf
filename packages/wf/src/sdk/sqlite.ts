import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import {
  WorkflowHistoryEvent as WorkflowHistoryEventSchema,
  WorkflowRunEventRecord as WorkflowRunEventRecordSchema,
  WorkflowRunRecord as WorkflowRunRecordSchema
} from "../schemas"
import type {
  WorkflowArtifact,
  WorkflowRepository,
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStore
} from "./artifact"
import { parseJsonText, toJsonText } from "./json"

interface WorkflowRow {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly source: string | null
  readonly entrypoint?: string | null
  readonly export_name: string | null
  readonly created_at: string | null
}

interface WorkflowRunRow {
  readonly id: string
  readonly workflow_id: string
  readonly workflow_version: string
  readonly status: WorkflowRunStatus
  readonly input_json: string
  readonly result_json: string | null
  readonly error_json: string | null
  readonly started_at: string
  readonly finished_at: string | null
}

interface WorkflowRunEventRow {
  readonly id: number
  readonly run_id: string
  readonly sequence: number
  readonly type: string
  readonly event_json: string
  readonly created_at: string
}

interface SqliteStatement<Row> {
  get(...params: ReadonlyArray<unknown>): Row | null
  all(...params: ReadonlyArray<unknown>): Row[]
  run(...params: ReadonlyArray<unknown>): unknown
}

interface SqliteDatabase {
  exec(sql: string): unknown
  prepare<Row>(sql: string): SqliteStatement<Row>
}

export interface SqliteWorkflowRepositoryOptions {
  readonly databasePath?: string
  readonly rootDir?: string
}

const defaultDatabasePath = (rootDir: string) => path.join(rootDir, ".wf", "wf.sqlite")

const nowIso = () => new Date().toISOString()

const optionalStringField = <K extends string>(
  key: K,
  value: string | undefined
): { readonly [P in K]?: string } => value === undefined ? {} : { [key]: value } as { readonly [P in K]?: string }

const toArtifact = (rootDir: string, row: WorkflowRow): WorkflowArtifact => ({
  id: row.id,
  name: row.name,
  version: row.version,
  source: row.source !== null && row.source.length > 0
    ? row.source
    : legacySourceFromEntrypoint(rootDir, row.entrypoint),
  ...optionalStringField("exportName", row.export_name ?? undefined),
  ...optionalStringField("createdAt", row.created_at ?? undefined)
})

const legacySourceFromEntrypoint = (rootDir: string, entrypoint: string | null | undefined): string => {
  if (entrypoint === undefined || entrypoint === null || entrypoint.length === 0) {
    throw new Error("Stored workflow row is missing source")
  }

  const sourcePath = path.isAbsolute(entrypoint)
    ? entrypoint
    : path.resolve(rootDir, entrypoint)

  return readFileSync(sourcePath, "utf8")
}

const toRunRecord = (row: WorkflowRunRow): WorkflowRunRecord => Schema.decodeUnknownSync(WorkflowRunRecordSchema)({
  id: row.id,
  workflowId: row.workflow_id,
  workflowVersion: row.workflow_version,
  status: row.status,
  input: JSON.parse(row.input_json),
  result: parseJsonText(row.result_json),
  error: parseJsonText(row.error_json),
  startedAt: row.started_at,
  ...optionalStringField("finishedAt", row.finished_at ?? undefined)
})

const toRunEventRecord = (row: WorkflowRunEventRow): WorkflowRunEventRecord => Schema.decodeUnknownSync(
  WorkflowRunEventRecordSchema
)({
  id: row.id,
  runId: row.run_id,
  sequence: row.sequence,
  type: row.type,
  event: Schema.decodeUnknownSync(WorkflowHistoryEventSchema)(JSON.parse(row.event_json)),
  createdAt: row.created_at
})

const normalizeParams = (params: ReadonlyArray<unknown>) =>
  params.map((param) => param === undefined ? null : param)

const createBunDatabase = async (databasePath: string): Promise<SqliteDatabase> => {
  const { Database } = await import("bun:sqlite")
  const db = new Database(databasePath, { create: true, readwrite: true })
  return {
    exec: (sql) => db.exec(sql),
    prepare: <Row>(sql: string): SqliteStatement<Row> => {
      const statement = db.query<Row, any>(sql)
      return {
        get: (...params) => statement.get(...params as any[]) ?? null,
        all: (...params) => statement.all(...params as any[]),
        run: (...params) => statement.run(...params as any[])
      }
    }
  }
}

const createNodeDatabase = async (databasePath: string): Promise<SqliteDatabase> => {
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(databasePath)
  return {
    exec: (sql) => db.exec(sql),
    prepare: <Row>(sql: string): SqliteStatement<Row> => {
      const statement = db.prepare(sql)
      return {
        get: (...params) => statement.get(...normalizeParams(params) as any[]) as Row | undefined ?? null,
        all: (...params) => statement.all(...normalizeParams(params) as any[]) as Row[],
        run: (...params) => statement.run(...normalizeParams(params) as any[])
      }
    }
  }
}

const createDatabase = async (databasePath: string): Promise<SqliteDatabase> =>
  process.versions.bun === undefined
    ? createNodeDatabase(databasePath)
    : createBunDatabase(databasePath)

const migrate = (db: SqliteDatabase) => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      entrypoint TEXT NOT NULL DEFAULT '',
      export_name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (name, version)
    );

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
      input_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id),
      UNIQUE (run_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS workflow_runs_workflow_id_idx
      ON workflow_runs(workflow_id);

    CREATE INDEX IF NOT EXISTS workflow_run_events_run_id_idx
      ON workflow_run_events(run_id, sequence);
  `)

  const columns = db.prepare<{ name: string }>("PRAGMA table_info(workflows)").all()
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has("source")) {
    db.prepare("ALTER TABLE workflows ADD COLUMN source TEXT NOT NULL DEFAULT ''").run()
  }

  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS workflows_name_version_idx ON workflows(name, version)").run()
}

export const createSqliteWorkflowRepository = (
  options: SqliteWorkflowRepositoryOptions = {}
): WorkflowRepository => {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  const databasePath = path.resolve(options.databasePath ?? defaultDatabasePath(rootDir))
  mkdirSync(path.dirname(databasePath), { recursive: true })

  const dbPromise = createDatabase(databasePath).then((db) => {
    migrate(db)
    return db
  })

  return {
    async upsertWorkflow(workflow) {
      const db = await dbPromise
      const existing = db.prepare<WorkflowRow>(`
        SELECT id, name, version, source, entrypoint, export_name, created_at
        FROM workflows
        WHERE name = ?
          AND version = ?
      `).get(workflow.name, workflow.version)

      if (existing !== null) {
        const existingSource = existing.source !== null && existing.source.length > 0
          ? existing.source
          : legacySourceFromEntrypoint(rootDir, existing.entrypoint)
        if (existingSource !== workflow.source) {
          throw new Error(
            `Workflow ${workflow.name}@v${workflow.version} is already cataloged with different source; register a new version instead`
          )
        }
        return
      }

      db.prepare<unknown>(`
        INSERT INTO workflows (id, name, version, source, entrypoint, export_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        workflow.id,
        workflow.name,
        workflow.version,
        workflow.source,
        "",
        workflow.exportName ?? null,
        workflow.createdAt ?? nowIso()
      )
    },

    async deleteWorkflow(id) {
      const db = await dbPromise
      db.prepare<unknown>("DELETE FROM workflows WHERE id = ?").run(id)
    },

    async list() {
      const db = await dbPromise
      const rows = db.prepare<WorkflowRow>(`
        SELECT id, name, version, source, entrypoint, export_name, created_at
        FROM workflows
        ORDER BY id
      `).all()
      return rows.map((row) => toArtifact(rootDir, row))
    },

    async get(id) {
      const db = await dbPromise
      const row = db.prepare<WorkflowRow>(`
        SELECT id, name, version, source, entrypoint, export_name, created_at
        FROM workflows
        WHERE id = ?
      `).get(id)
      return row === null ? undefined : toArtifact(rootDir, row)
    },

    async getRun(id) {
      const db = await dbPromise
      const row = db.prepare<WorkflowRunRow>(`
        SELECT *
        FROM workflow_runs
        WHERE id = ?
      `).get(id)
      return row === null ? undefined : toRunRecord(row)
    },

    async startRun({ id, workflow, input }) {
      const db = await dbPromise
      const startedAt = nowIso()
      db.prepare<unknown>(`
        INSERT INTO workflow_runs (
          id,
          workflow_id,
          workflow_version,
          status,
          input_json,
          started_at
        )
        VALUES (?, ?, ?, 'running', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = 'running',
          input_json = excluded.input_json,
          result_json = NULL,
          error_json = NULL,
          started_at = excluded.started_at,
          finished_at = NULL
      `).run(id, workflow.id, workflow.version, toJsonText(input), startedAt)

      const row = db.prepare<WorkflowRunRow>(`
        SELECT *
        FROM workflow_runs
        WHERE id = ?
      `).get(id)

      if (row === null) {
        throw new Error(`Failed to create workflow run ${id}`)
      }

      return toRunRecord(row)
    },

    async appendRunEvent({ runId, type, event }) {
      const db = await dbPromise
      const nextSequence = db.prepare<{ sequence: number }>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM workflow_run_events
        WHERE run_id = ?
      `).get(runId)?.sequence ?? 1

      db.prepare<unknown>(`
        INSERT INTO workflow_run_events (run_id, sequence, type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, nextSequence, type, toJsonText(event), nowIso())
    },

    async completeRun({ runId, result }) {
      const db = await dbPromise
      db.prepare<unknown>(`
        UPDATE workflow_runs
        SET status = 'completed',
          result_json = ?,
          error_json = NULL,
          finished_at = ?
        WHERE id = ?
      `).run(toJsonText(result), nowIso(), runId)
    },

    async failRun({ runId, error }) {
      const db = await dbPromise
      db.prepare<unknown>(`
        UPDATE workflow_runs
        SET status = 'failed',
          error_json = ?,
          finished_at = ?
        WHERE id = ?
      `).run(toJsonText(error), nowIso(), runId)
    },

    async listRuns() {
      const db = await dbPromise
      const rows = db.prepare<WorkflowRunRow>(`
        SELECT *
        FROM workflow_runs
        ORDER BY started_at DESC
      `).all()
      return rows.map(toRunRecord)
    },

    async listRunEvents(runId) {
      const db = await dbPromise
      const rows = db.prepare<WorkflowRunEventRow>(`
        SELECT *
        FROM workflow_run_events
        WHERE run_id = ?
        ORDER BY sequence
      `).all(runId)
      return rows.map(toRunEventRecord)
    }
  }
}

export const seedSqliteWorkflowRepository = async (
  repository: WorkflowRepository,
  seedStore: WorkflowStore
) => {
  if ((await repository.list()).length > 0) {
    return
  }

  for (const workflow of await seedStore.list()) {
    await repository.upsertWorkflow(workflow)
  }
}
