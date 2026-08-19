import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import type { Dirent } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { WorkflowId, workflowIdPattern } from "../schemas.ts"
import type { WorkflowArtifact } from "../schemas.ts"
import type { WorkflowStore } from "./artifact.ts"

/**
 * The catalog is a directory of TypeScript files, one workflow per file, and the
 * file is the only authority for its source. Anything that can edit a file can
 * edit a workflow — the CLI is a convenience, not the gatekeeper.
 */
export interface WorkflowCatalog extends WorkflowStore {
  /** Write `source` as the workflow's file, replacing whatever was there. */
  write(id: WorkflowId, source: string): Promise<WorkflowArtifact>
  remove(id: WorkflowId): Promise<void>
  /** The file an agent or editor should open to change this workflow. */
  pathFor(id: WorkflowId): string
  readonly directory: string
}

export interface WorkflowCatalogOptions {
  readonly directory: string
}

const workflowExtension = ".ts"

// A caught value. TypeScript types every catch binding as unknown because
// JavaScript lets any value be thrown, so there is nothing narrower to accept.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
const isFileSystemError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId)

export const parseWorkflowId = (value: string): WorkflowId => {
  if (!workflowIdPattern.test(value)) {
    throw new Error(
      `Invalid workflow id: ${value}. Ids start with a lowercase letter and contain only lowercase letters, numbers, and dashes.`
    )
  }
  return decodeWorkflowId(value)
}

/**
 * Ids double as filenames, so the id rules are also the file naming rules.
 * A value carrying any path of its own is rejected rather than reduced to its
 * basename, so `../secrets.ts` cannot quietly become the workflow `secrets`.
 */
export const workflowIdFromFilename = (filename: string): WorkflowId | undefined => {
  if (path.basename(filename) !== filename) {
    return undefined
  }
  const stem = path.basename(filename, workflowExtension)
  return workflowIdPattern.test(stem) ? decodeWorkflowId(stem) : undefined
}

const timestampsOf = async (
  file: string
): Promise<Pick<WorkflowArtifact, "createdAt" | "updatedAt">> => {
  try {
    const metadata = await stat(file)
    const createdAt = metadata.birthtime.getTime() > 0 ? metadata.birthtime : metadata.mtime
    return {
      createdAt: createdAt.toISOString(),
      updatedAt: metadata.mtime.toISOString()
    }
  } catch {
    return {}
  }
}

const readArtifact = async (
  directory: string,
  id: WorkflowId
): Promise<WorkflowArtifact | undefined> => {
  const file = path.join(directory, `${id}${workflowExtension}`)
  let source: string
  try {
    source = await readFile(file, "utf8")
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return undefined
    }
    throw error
  }
  const timestamps = await timestampsOf(file)
  return {
    id,
    source,
    ...timestamps
  }
}

export const createDirectoryWorkflowCatalog = (
  options: WorkflowCatalogOptions
): WorkflowCatalog => {
  const directory = path.resolve(options.directory)

  return {
    directory,

    pathFor(id) {
      return path.join(directory, `${parseWorkflowId(id)}${workflowExtension}`)
    },

    async list() {
      let entries: ReadonlyArray<Dirent<string>>
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if (isFileSystemError(error, "ENOENT")) {
          return []
        }
        throw error
      }
      // Files that do not name a valid id are left alone rather than reported
      // as broken workflows: the directory is a user-visible place and may hold
      // notes, drafts, or a .git directory.
      const ids = entries
        .filter((entry) => entry.isFile())
        .filter((entry) => entry.name.endsWith(workflowExtension))
        .flatMap((entry) => {
          const id = workflowIdFromFilename(entry.name)
          return id === undefined ? [] : [id]
        })
        .sort()
      const artifacts = await Promise.all(ids.map((id) => readArtifact(directory, id)))
      return artifacts.flatMap((artifact) => artifact === undefined ? [] : [artifact])
    },

    // async so that a rejected id surfaces the same way as a filesystem error,
    // rather than throwing before the promise exists.
    async get(id) {
      return readArtifact(directory, parseWorkflowId(id))
    },

    async write(id, source) {
      const workflowId = parseWorkflowId(id)
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, `${workflowId}${workflowExtension}`)
      await writeFile(file, source, "utf8")
      const artifact = await readArtifact(directory, workflowId)
      if (artifact === undefined) {
        throw new Error(`Failed to write workflow ${id} to ${file}`)
      }
      return artifact
    },

    async remove(id) {
      await rm(path.join(directory, `${parseWorkflowId(id)}${workflowExtension}`), { force: true })
    }
  }
}
