import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  createDirectoryWorkflowCatalog,
  createWorkflowSourceStore,
  hashWorkflowSource,
  parseWorkflowId,
  workflowIdFromFilename
} from "../src/sdk/index.ts"

const directories: Array<string> = []

const makeDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "wf-catalog-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("directory workflow catalog", () => {
  test("writes, reads, lists, and removes workflow files", async () => {
    const directory = path.join(makeDirectory(), "workflows")
    const catalog = createDirectoryWorkflowCatalog({ directory })

    expect(await catalog.list()).toEqual([])

    const written = await catalog.write(parseWorkflowId("beta"), "export const b = 2\n")
    await catalog.write(parseWorkflowId("alpha"), "export const a = 1\n")

    expect(written.id).toBe(parseWorkflowId("beta"))
    expect(catalog.pathFor(parseWorkflowId("beta"))).toBe(path.join(directory, "beta.ts"))
    expect((await catalog.list()).map((workflow) => workflow.id)).toEqual(["alpha", "beta"].map(parseWorkflowId))
    expect((await catalog.get("alpha"))?.source).toBe("export const a = 1\n")
    expect((await catalog.get("alpha"))?.createdAt).toBeDefined()
    const modifiedAt = new Date("2026-08-12T12:34:56.000Z")
    await utimes(catalog.pathFor(parseWorkflowId("alpha")), modifiedAt, modifiedAt)
    expect((await catalog.get("alpha"))?.updatedAt).toBe(modifiedAt.toISOString())

    await catalog.remove(parseWorkflowId("alpha"))
    expect(await catalog.get("alpha")).toBeUndefined()
    expect((await catalog.list()).map((workflow) => workflow.id)).toEqual([parseWorkflowId("beta")])
  })

  test("ignores directory entries that are not workflow files", async () => {
    const directory = path.join(makeDirectory(), "workflows")
    await mkdir(path.join(directory, ".git"), { recursive: true })
    await mkdir(path.join(directory, "build.ts"), { recursive: true })
    await writeFile(path.join(directory, "notes.md"), "not a workflow", "utf8")
    await writeFile(path.join(directory, "Draft Copy.ts"), "invalid id", "utf8")
    await writeFile(path.join(directory, "real.ts"), "export const real = 1\n", "utf8")

    const catalog = createDirectoryWorkflowCatalog({ directory })
    expect((await catalog.list()).map((workflow) => workflow.id)).toEqual([parseWorkflowId("real")])
  })

  test("rejects ids that would escape the catalog directory", async () => {
    const directory = path.join(makeDirectory(), "workflows")
    const catalog = createDirectoryWorkflowCatalog({ directory })

    for (const id of ["../escape", "/etc/passwd", "nested/child", "Upper", ""]) {
      await expect(catalog.get(id)).rejects.toThrow("Invalid workflow id")
    }
    expect(workflowIdFromFilename("../escape.ts")).toBeUndefined()
  })

  test("reports a missing workflow rather than throwing", async () => {
    const catalog = createDirectoryWorkflowCatalog({ directory: path.join(makeDirectory(), "absent") })
    expect(await catalog.get("nothing")).toBeUndefined()
    expect(await catalog.list()).toEqual([])
  })
})

describe("workflow source snapshots", () => {
  test("addresses a source by content and reads it back", async () => {
    const store = createWorkflowSourceStore({ directory: path.join(makeDirectory(), "sources") })
    const source = "export const pinned = 1\n"

    const hash = await store.save(source)
    expect(hash).toBe(hashWorkflowSource(source))
    expect(await store.read(hash)).toBe(source)
    // Saving the same source twice is the same snapshot, not a second copy.
    expect(await store.save(source)).toBe(hash)
    expect(await store.read(hash)).toBe(source)
    expect(await store.read(hashWorkflowSource("export const other = 2\n"))).toBeUndefined()
  })

  test("keeps snapshots of different sources apart", async () => {
    const store = createWorkflowSourceStore({ directory: path.join(makeDirectory(), "sources") })
    const first = await store.save("first\n")
    const second = await store.save("second\n")

    expect(first).not.toBe(second)
    expect(await store.read(first)).toBe("first\n")
    expect(await store.read(second)).toBe("second\n")
  })
})
