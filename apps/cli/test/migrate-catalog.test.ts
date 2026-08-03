import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { migrateLegacyCatalog } from "../src/migrate-catalog.ts"
import { legacyCatalogPath, workflowsPath } from "../src/paths.ts"

const homes: Array<string> = []

const makeHome = () => {
  const home = mkdtempSync(path.join(tmpdir(), "wf-migrate-"))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

const seedLegacyCatalog = (
  home: string,
  rows: ReadonlyArray<{ readonly id: string; readonly source: string }>
) => {
  const database = new Database(legacyCatalogPath(home), { create: true, readwrite: true })
  // WAL is how the old catalog was actually written, and it is what makes the
  // rows live outside the main database file until a checkpoint.
  database.exec("PRAGMA journal_mode = WAL")
  database.exec(`
    CREATE TABLE workflows (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      entrypoint TEXT NOT NULL DEFAULT '',
      export_name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (name)
    );
  `)
  for (const row of rows) {
    database.query(`
      INSERT INTO workflows (id, name, source, entrypoint, export_name, created_at)
      VALUES (?, ?, ?, '', ?, ?)
    `).run(row.id, `${row.id}-name`, row.source, null, new Date().toISOString())
  }
  database.close()
}

describe("legacy catalog migration", () => {
  test("unpacks stored sources into workflow files and sets the database aside", async () => {
    const home = makeHome()
    seedLegacyCatalog(home, [
      { id: "alpha", source: "export const alpha = 1\n" },
      { id: "beta", source: "export const beta = 2\n" }
    ])

    expect(await migrateLegacyCatalog(home)).toEqual(["alpha", "beta"])
    expect(await readFile(path.join(workflowsPath(home), "alpha.ts"), "utf8")).toBe(
      "export const alpha = 1\n"
    )
    expect(await readFile(path.join(workflowsPath(home), "beta.ts"), "utf8")).toBe(
      "export const beta = 2\n"
    )
    expect(existsSync(legacyCatalogPath(home))).toBe(false)
    expect(existsSync(`${legacyCatalogPath(home)}.migrated`)).toBe(true)

    // Whatever the migration leaves behind has to be a readable catalog, not an
    // empty shell missing the content that lived in its write-ahead file.
    const kept = new Database(`${legacyCatalogPath(home)}.migrated`, { readonly: true })
    expect(
      kept.query<{ readonly id: string }, []>("SELECT id FROM workflows ORDER BY id").all()
        .map((row) => row.id)
    ).toEqual(["alpha", "beta"])
    kept.close()

    // Running again is a no-op rather than a second migration.
    expect(await migrateLegacyCatalog(home)).toEqual([])
  })

  test("never overwrites a workflow file that already exists", async () => {
    const home = makeHome()
    seedLegacyCatalog(home, [{ id: "alpha", source: "export const fromDatabase = 1\n" }])
    await Bun.write(path.join(workflowsPath(home), "alpha.ts"), "export const fromFile = 1\n")

    expect(await migrateLegacyCatalog(home)).toEqual([])
    expect(await readFile(path.join(workflowsPath(home), "alpha.ts"), "utf8")).toBe(
      "export const fromFile = 1\n"
    )
  })

  test("does nothing when there is no legacy catalog", async () => {
    expect(await migrateLegacyCatalog(makeHome())).toEqual([])
  })

  test("never overwrites an already archived catalog", async () => {
    const home = makeHome()
    seedLegacyCatalog(home, [{ id: "alpha", source: "export const first = 1\n" }])
    expect(await migrateLegacyCatalog(home)).toEqual(["alpha"])

    // A second legacy database in the same home — the first archive must survive.
    seedLegacyCatalog(home, [{ id: "gamma", source: "export const second = 1\n" }])
    expect(await migrateLegacyCatalog(home)).toEqual(["gamma"])

    const firstArchive = new Database(`${legacyCatalogPath(home)}.migrated`, { readonly: true })
    expect(
      firstArchive.query<{ readonly id: string }, []>("SELECT id FROM workflows").all()
        .map((row) => row.id)
    ).toEqual(["alpha"])
    firstArchive.close()
    expect(existsSync(`${legacyCatalogPath(home)}.migrated.2`)).toBe(true)
  })
})
