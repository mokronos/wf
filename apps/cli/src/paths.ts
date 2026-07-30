import path from "node:path"
import { homedir } from "node:os"

export const defaultWfHome = (): string => path.join(homedir(), ".wf")

export const wfHome = (environment: NodeJS.ProcessEnv = process.env): string => {
  const configured = environment["WF_HOME"]
  return configured === undefined || configured.length === 0 ? defaultWfHome() : path.resolve(configured)
}

export const repositoryPath = (home: string): string => path.join(home, "wf.sqlite")
export const serviceLogPath = (home: string): string => path.join(home, "logs", "wf.log")
export const serviceErrorLogPath = (home: string): string => path.join(home, "logs", "wf.error.log")
