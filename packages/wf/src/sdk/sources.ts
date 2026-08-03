import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"

/**
 * The sha256 of a workflow source, and the name of the file holding it.
 * Content addressing is what makes the snapshot store append-only: the same
 * source saved twice is one file, and a saved source is never rewritten.
 */
export const WorkflowSourceHash = Schema.String.pipe(
  Schema.refine((value): value is string => /^[0-9a-f]{64}$/.test(value)),
  Schema.brand("WorkflowSourceHash")
)
export type WorkflowSourceHash = typeof WorkflowSourceHash.Type

const decodeHash = Schema.decodeUnknownSync(WorkflowSourceHash)

export const hashWorkflowSource = (source: string): WorkflowSourceHash =>
  decodeHash(createHash("sha256").update(source).digest("hex"))

export const parseWorkflowSourceHash = (value: string): WorkflowSourceHash => {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`Invalid workflow source hash: ${value}`)
  }
  return decodeHash(value)
}

/**
 * Snapshots of the source each execution started against.
 *
 * A catalog file is editable at any time, including while a run of it is parked
 * on a signal. Replaying that run against the edited file could take a different
 * path than the recorded history, so an execution pins the snapshot it began
 * with and resumes against that, leaving the catalog file free to move on.
 */
export interface WorkflowSourceStore {
  /** Saves the source if it is not already stored and returns its hash. */
  save(source: string): Promise<WorkflowSourceHash>
  read(hash: WorkflowSourceHash): Promise<string | undefined>
  pathFor(hash: WorkflowSourceHash): string
  readonly directory: string
}

export interface WorkflowSourceStoreOptions {
  readonly directory: string
}

export const createWorkflowSourceStore = (
  options: WorkflowSourceStoreOptions
): WorkflowSourceStore => {
  const directory = path.resolve(options.directory)
  const fileFor = (hash: WorkflowSourceHash) => path.join(directory, `${hash}.ts`)

  return {
    directory,

    pathFor(hash) {
      return fileFor(hash)
    },

    async save(source) {
      const hash = hashWorkflowSource(source)
      await mkdir(directory, { recursive: true })
      // wx: identical content is already there, and a snapshot is never updated.
      await writeFile(fileFor(hash), source, { encoding: "utf8", flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        }
      )
      return hash
    },

    async read(hash) {
      try {
        return await readFile(fileFor(hash), "utf8")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined
        }
        throw error
      }
    }
  }
}
