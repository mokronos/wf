import { Schema } from "effect"
import {
  IntegrationNodeConfig,
  type IntegrationValidationFinding,
  type IntegrationValidationReport
} from "./integration-model.ts"
import { ExecutorToolAddress } from "./schemas.ts"
import { listExecutorToolSummaries } from "./tools.ts"
import type { ExecutorTools } from "./tools.ts"

export interface IntegrationValidationDependencies {
  readonly tools: Pick<ExecutorTools, "summaries">
}

const finding = (
  severity: IntegrationValidationFinding["severity"],
  check: string,
  message: string
): IntegrationValidationFinding => ({ severity, check, message })

export const createIntegrationValidation = (
  dependencies: IntegrationValidationDependencies
) => async (
    config: typeof Schema.Json.Type,
    options: { readonly live?: boolean } = {}
  ): Promise<IntegrationValidationReport> => {
  let node: typeof IntegrationNodeConfig.Type
  try {
    node = await Schema.decodeUnknownPromise(IntegrationNodeConfig)(config)
  } catch (error) {
    return {
      ok: false,
      findings: [finding("error", "structural", `invalid integration node: ${String(error)}`)]
    }
  }
  const findings: Array<IntegrationValidationFinding> = [
    finding("info", "structural", "Executor tool address is valid")
  ]
  if (options.live === true) {
    const tool = (await dependencies.tools.summaries()).find((candidate) =>
      candidate.address === node.source.address
    )
    if (tool === undefined) {
      findings.push(finding("error", "catalog", `Executor tool not found: ${node.source.address}`))
    } else {
      findings.push(finding("info", "catalog", `${tool.name} is available`))
    }
  }
  return {
    ok: !findings.some((entry) => entry.severity === "error"),
    findings
  }
}

export const validateIntegrationNode = createIntegrationValidation({
  tools: { summaries: listExecutorToolSummaries }
})

export const validateExecutorToolAddress = async (
  address: string,
  tools: Pick<ExecutorTools, "summaries"> = { summaries: listExecutorToolSummaries }
): Promise<IntegrationValidationReport> => {
  let decoded: typeof ExecutorToolAddress.Type
  try {
    decoded = await Schema.decodeUnknownPromise(ExecutorToolAddress)(address)
  } catch (error) {
    return {
      ok: false,
      findings: [finding("error", "structural", `invalid Executor tool address: ${String(error)}`)]
    }
  }
  try {
    return await createIntegrationValidation({ tools })(
      { source: { kind: "executor", address: decoded } },
      { live: true }
    )
  } catch (error) {
    return {
      ok: false,
      findings: [
        finding("info", "structural", "Executor tool address is valid"),
        finding("error", "catalog", `Could not inspect Executor tools: ${String(error)}`)
      ]
    }
  }
}

export const validateExecutorToolAddresses = async (
  addresses: ReadonlyArray<string>,
  tools: Pick<ExecutorTools, "summaries"> = { summaries: listExecutorToolSummaries }
): Promise<ReadonlyArray<{ readonly address: string; readonly report: IntegrationValidationReport }>> => {
  if (addresses.length === 0) return []
  let summaries: Awaited<ReturnType<ExecutorTools["summaries"]>>
  try {
    summaries = await tools.summaries()
  } catch (error) {
    return addresses.map((address) => ({
      address,
      report: {
        ok: false,
        findings: [finding("error", "catalog", `Could not inspect Executor tools: ${String(error)}`)]
      }
    }))
  }
  const snapshot = { summaries: async () => summaries }
  const reports: Array<{ readonly address: string; readonly report: IntegrationValidationReport }> = []
  for (const address of addresses) {
    reports.push({ address, report: await validateExecutorToolAddress(address, snapshot) })
  }
  return reports
}
