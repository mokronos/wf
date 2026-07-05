import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import type { WorkflowEvent } from "../events"
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

const toRunRecord = (row: WorkflowRunRow): WorkflowRunRecord => ({
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

const toRunEventRecord = (row: WorkflowRunEventRow): WorkflowRunEventRecord => ({
  id: row.id,
  runId: row.run_id,
  sequence: row.sequence,
  type: row.type,
  event: JSON.parse(row.event_json) as WorkflowEvent,
  createdAt: row.created_at
})

const migrate = (db: Database) => {
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

  const columns = db.query<{ name: string }, []>("PRAGMA table_info(workflows)").all()
  const columnNames = new Set(columns.map((column) => column.name))
  if (!columnNames.has("source")) {
    db.run("ALTER TABLE workflows ADD COLUMN source TEXT NOT NULL DEFAULT ''")
  }

  db.run("CREATE UNIQUE INDEX IF NOT EXISTS workflows_name_version_idx ON workflows(name, version)")
}

export const createSqliteWorkflowRepository = (
  options: SqliteWorkflowRepositoryOptions = {}
): WorkflowRepository => {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  const databasePath = path.resolve(options.databasePath ?? defaultDatabasePath(rootDir))
  mkdirSync(path.dirname(databasePath), { recursive: true })

  const db = new Database(databasePath, { create: true, readwrite: true })
  migrate(db)

  return {
    async upsertWorkflow(workflow) {
      const existing = db.query<WorkflowRow, [string, string]>(`
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

      db.query<unknown, [string, string, string, string, string, string | null, string]>(`
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

    async list() {
      const rows = db.query<WorkflowRow, []>(`
        SELECT id, name, version, source, entrypoint, export_name, created_at
        FROM workflows
        ORDER BY id
      `).all()
      return rows.map((row) => toArtifact(rootDir, row))
    },

    async get(id) {
      const row = db.query<WorkflowRow, [string]>(`
        SELECT id, name, version, source, entrypoint, export_name, created_at
        FROM workflows
        WHERE id = ?
      `).get(id)
      return row === null ? undefined : toArtifact(rootDir, row)
    },

    async getRun(id) {
      const row = db.query<WorkflowRunRow, [string]>(`
        SELECT *
        FROM workflow_runs
        WHERE id = ?
      `).get(id)
      return row === null ? undefined : toRunRecord(row)
    },

    async startRun({ id, workflow, input }) {
      const startedAt = nowIso()
      db.query<unknown, [string, string, string, string, string]>(`
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

      const row = db.query<WorkflowRunRow, [string]>(`
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
      const nextSequence = db.query<{ sequence: number }, [string]>(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM workflow_run_events
        WHERE run_id = ?
      `).get(runId)?.sequence ?? 1

      db.query<unknown, [string, number, string, string, string]>(`
        INSERT INTO workflow_run_events (run_id, sequence, type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(runId, nextSequence, type, toJsonText(event), nowIso())
    },

    async completeRun({ runId, result }) {
      db.query<unknown, [string, string, string]>(`
        UPDATE workflow_runs
        SET status = 'completed',
          result_json = ?,
          error_json = NULL,
          finished_at = ?
        WHERE id = ?
      `).run(toJsonText(result), nowIso(), runId)
    },

    async failRun({ runId, error }) {
      db.query<unknown, [string, string, string]>(`
        UPDATE workflow_runs
        SET status = 'failed',
          error_json = ?,
          finished_at = ?
        WHERE id = ?
      `).run(toJsonText(error), nowIso(), runId)
    },

    async listRuns() {
      const rows = db.query<WorkflowRunRow, []>(`
        SELECT *
        FROM workflow_runs
        ORDER BY started_at DESC
      `).all()
      return rows.map(toRunRecord)
    },

    async listRunEvents(runId) {
      const rows = db.query<WorkflowRunEventRow, [string]>(`
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
