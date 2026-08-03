import path from "node:path"
import { homedir } from "node:os"

export const defaultWfHome = (): string => path.join(homedir(), ".wf")

export const wfHome = (environment: NodeJS.ProcessEnv = process.env): string => {
  const configured = environment["WF_HOME"]
  return configured === undefined || configured.length === 0 ? defaultWfHome() : path.resolve(configured)
}

/** Editable workflow sources, one `.ts` file per workflow id. */
export const workflowsPath = (home: string): string => path.join(home, "workflows")
/** Immutable snapshots of the source each run started against. */
export const sourcesPath = (home: string): string => path.join(home, "sources")
export const enginePath = (home: string): string => path.join(home, "engine.sqlite")
export const legacyCatalogPath = (home: string): string => path.join(home, "wf.sqlite")
export const serviceLogPath = (home: string): string => path.join(home, "logs", "wf.log")
export const serviceErrorLogPath = (home: string): string => path.join(home, "logs", "wf.error.log")
