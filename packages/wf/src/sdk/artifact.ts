import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import {
  WorkflowArtifact as WorkflowArtifactSchema,
  WorkflowManifest,
  WorkflowManifestEntry,
  type WorkflowArtifact,
  type WorkflowRunEventRecord,
  type WorkflowRunRecord,
  type WorkflowRunStatus
} from "../schemas"

export type { WorkflowArtifact, WorkflowRunEventRecord, WorkflowRunRecord, WorkflowRunStatus }

export interface WorkflowStore {
  list(): Promise<ReadonlyArray<WorkflowArtifact>>
  get(id: string): Promise<WorkflowArtifact | undefined>
}

export interface WorkflowRunStore {
  getRun(id: string): Promise<WorkflowRunRecord | undefined>
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
  /** Remove every catalog row for a workflow id (all names/versions). */
  deleteWorkflow(id: string): Promise<void>
}

export interface FileWorkflowStoreOptions {
  readonly rootDir?: string
  readonly manifestPath?: string
}

const defaultManifestPath = (rootDir: string) => path.join(rootDir, ".wf", "workflows.json")

interface NormalizedWorkflowManifest {
  readonly workflows: ReadonlyArray<WorkflowArtifact>
}

const readManifest = async (rootDir: string, manifestPath: string): Promise<NormalizedWorkflowManifest> => {
  let raw: string

  try {
    raw = await readFile(manifestPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { workflows: [] }
    }
    throw error
  }

  const parsed: unknown = JSON.parse(raw)
  const manifest = Schema.decodeUnknownSync(WorkflowManifest)(parsed)

  return {
    workflows: manifest.workflows.map((workflow, index) =>
      normalizeArtifact(rootDir, workflow, `workflow manifest entry ${index}`)
    )
  }
}

const requiredString = (
  value: WorkflowManifestEntry,
  key: "id" | "name" | "version",
  label: string
): string => {
  const field = value[key]
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`)
  }
  return field
}

const nonEmptyOptionalString = (
  field: string | undefined,
  key: keyof WorkflowManifestEntry,
  label: string
): string | undefined => {
  if (field === undefined) {
    return undefined
  }
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string when present`)
  }
  return field
}

const normalizeArtifact = (rootDir: string, value: unknown, label: string): WorkflowArtifact => {
  const artifact = Schema.decodeUnknownSync(WorkflowManifestEntry)(value)
  const source = nonEmptyOptionalString(artifact.source, "source", label)
  const entrypoint = nonEmptyOptionalString(artifact.entrypoint, "entrypoint", label)
  const exportName = nonEmptyOptionalString(artifact.exportName, "exportName", label)
  const createdAt = nonEmptyOptionalString(artifact.createdAt, "createdAt", label)

  return Schema.decodeUnknownSync(WorkflowArtifactSchema)({
    id: requiredString(artifact, "id", label),
    name: requiredString(artifact, "name", label),
    version: requiredString(artifact, "version", label),
    source: source ?? readLegacySource(rootDir, entrypoint, label),
    ...(exportName === undefined ? {} : { exportName }),
    ...(createdAt === undefined ? {} : { createdAt })
  })
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
