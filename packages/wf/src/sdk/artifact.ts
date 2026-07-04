import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

export interface WorkflowArtifact {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly source: string
  readonly exportName?: string
  readonly createdAt?: string
}

export interface WorkflowStore {
  list(): Promise<ReadonlyArray<WorkflowArtifact>>
  get(id: string): Promise<WorkflowArtifact | undefined>
}

export interface WorkflowRunRecord {
  readonly id: string
  readonly workflowId: string
  readonly workflowVersion: string
  readonly status: WorkflowRunStatus
  readonly input: unknown
  readonly result?: unknown
  readonly error?: unknown
  readonly startedAt: string
  readonly finishedAt?: string
}

export type WorkflowRunStatus = "running" | "completed" | "failed"

export interface WorkflowRunEventRecord {
  readonly id: number
  readonly runId: string
  readonly sequence: number
  readonly type: string
  readonly event: unknown
  readonly createdAt: string
}

export interface WorkflowRunStore {
  startRun(options: {
    readonly id: string
    readonly workflow: WorkflowArtifact
    readonly input: unknown
  }): Promise<WorkflowRunRecord>
  appendRunEvent(options: {
    readonly runId: string
    readonly type: string
    readonly event: unknown
  }): Promise<void>
  completeRun(options: {
    readonly runId: string
    readonly result: unknown
  }): Promise<void>
  failRun(options: {
    readonly runId: string
    readonly error: unknown
  }): Promise<void>
  listRuns(): Promise<ReadonlyArray<WorkflowRunRecord>>
  listRunEvents(runId: string): Promise<ReadonlyArray<WorkflowRunEventRecord>>
}

export interface WorkflowRepository extends WorkflowStore, WorkflowRunStore {
  upsertWorkflow(workflow: WorkflowArtifact): Promise<void>
}

interface WorkflowManifest {
  readonly workflows: ReadonlyArray<WorkflowArtifact>
}

export interface FileWorkflowStoreOptions {
  readonly rootDir?: string
  readonly manifestPath?: string
}

const defaultManifestPath = (rootDir: string) => path.join(rootDir, ".wf", "workflows.json")

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const readManifest = async (rootDir: string, manifestPath: string): Promise<WorkflowManifest> => {
  let raw: string

  try {
    raw = await readFile(manifestPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { workflows: [] }
    }
    throw error
  }

  const parsed = JSON.parse(raw) as unknown
  const manifest = asRecord(parsed, "workflow manifest")

  if (!Array.isArray(manifest.workflows)) {
    throw new Error("workflow manifest must contain a workflows array")
  }

  return {
    workflows: manifest.workflows.map((workflow, index) =>
      normalizeArtifact(rootDir, workflow, `workflow manifest entry ${index}`)
    )
  }
}

const requiredString = (
  value: Record<string, unknown>,
  key: keyof WorkflowArtifact,
  label: string
): string => {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`)
  }
  return field
}

const optionalString = (
  value: Record<string, unknown>,
  key: string,
  label: string
): string | undefined => {
  const field = value[key]
  if (field === undefined) {
    return undefined
  }
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string when present`)
  }
  return field
}

const normalizeArtifact = (rootDir: string, value: unknown, label: string): WorkflowArtifact => {
  const artifact = asRecord(value, label)
  const source = optionalString(artifact, "source", label)
  const entrypoint = optionalString(artifact, "entrypoint", label)
  const exportName = optionalString(artifact, "exportName", label)
  const createdAt = optionalString(artifact, "createdAt", label)

  return {
    id: requiredString(artifact, "id", label),
    name: requiredString(artifact, "name", label),
    version: requiredString(artifact, "version", label),
    source: source ?? readLegacySource(rootDir, entrypoint, label),
    ...(exportName === undefined ? {} : { exportName }),
    ...(createdAt === undefined ? {} : { createdAt })
  }
}

const readLegacySource = (rootDir: string, entrypoint: string | undefined, label: string): string => {
  if (entrypoint === undefined) {
    throw new Error(`${label}.source must be a non-empty string`)
  }

  const sourcePath = path.isAbsolute(entrypoint)
    ? entrypoint
    : path.resolve(rootDir, entrypoint)
  try {
    return readFileSync(sourcePath, "utf8")
  } catch (error) {
    throw new Error(`${label}.entrypoint could not be read: ${(error as Error).message}`)
  }
}

export const createFileWorkflowStore = (
  options: FileWorkflowStoreOptions = {}
): WorkflowStore => {
  const rootDir = path.resolve(options.rootDir ?? process.cwd())
  const manifestPath = path.resolve(options.manifestPath ?? defaultManifestPath(rootDir))

  return {
    async list() {
      const manifest = await readManifest(rootDir, manifestPath)
      return manifest.workflows
    },

    async get(id) {
      const workflows = await this.list()
      return workflows.find((workflow) => workflow.id === id)
    }
  }
}

export const createMemoryWorkflowStore = (
  workflows: ReadonlyArray<WorkflowArtifact>
): WorkflowStore => {
  const artifacts = workflows.map((workflow) => ({ ...workflow }))

  return {
    async list() {
      return artifacts
    },

    async get(id) {
      return artifacts.find((workflow) => workflow.id === id)
    }
  }
}
