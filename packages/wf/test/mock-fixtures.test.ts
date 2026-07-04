import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type Json = null | boolean | number | string | Json[] | { readonly [key: string]: Json }

interface WorkflowFixtures {
  readonly workflows: readonly WorkflowFixture[]
}

interface WorkflowFixture {
  readonly slug: string
  readonly cases: readonly WorkflowCase[]
}

interface WorkflowCase {
  readonly caseId: string
  readonly expectedOutput: Json
  readonly nodes: readonly FixtureNode[]
}

interface FixtureNode {
  readonly id: string
  readonly operation: string
  readonly cacheKey: string
  readonly cacheable: boolean
  readonly input: Json
  readonly expectedOutput: Json
}

interface RunResult {
  readonly finalOutput: Json
  readonly nodeOutputs: ReadonlyMap<string, Json>
  readonly executedNodeIds: readonly string[]
  readonly cacheHits: readonly string[]
}

const fixturesPath = path.join(
  process.cwd(),
  "examples/spec/mock/fixtures/fully-specified-workflows.json"
)

const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as WorkflowFixtures

const deepClone = <T extends Json>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const executeCase = (
  workflowCase: WorkflowCase,
  initialCache: ReadonlyMap<string, Json> = new Map()
): RunResult => {
  const cache = new Map(initialCache)
  const nodeOutputs = new Map<string, Json>()
  const executedNodeIds: string[] = []
  const cacheHits: string[] = []

  for (const node of workflowCase.nodes) {
    const cached = node.cacheable ? cache.get(node.cacheKey) : undefined
    if (cached !== undefined) {
      cacheHits.push(node.id)
      nodeOutputs.set(node.id, deepClone(cached))
      continue
    }

    const output = runOperation(node.operation, node.input)
    executedNodeIds.push(node.id)
    nodeOutputs.set(node.id, output)

    if (node.cacheable) {
      cache.set(node.cacheKey, deepClone(output))
    }
  }

  const finalOutput = nodeOutputs.get(workflowCase.nodes.at(-1)?.id ?? "")
  if (finalOutput === undefined) {
    throw new Error(`Workflow case ${workflowCase.caseId} produced no final output`)
  }

  return { finalOutput, nodeOutputs, executedNodeIds, cacheHits }
}

const runOperation = (operation: string, input: Json): Json => {
  switch (operation) {
    case "math.loadProblems":
      return mathLoadProblems(input)
    case "math.solveProblems":
      return mathSolveProblems(input)
    case "math.checkTolerance":
      return mathCheckTolerance(input)
    case "math.applyReview":
      return mathApplyReview(input)
    case "math.reviewTimeout":
      return mathReviewTimeout(input)
    case "math.generateReport":
      return mathGenerateReport(input)
    case "file.dedupeEvents":
      return fileDedupeEvents(input)
    case "file.validateCsvHeaders":
      return fileValidateCsvHeaders(input)
    case "file.normalizeCsv":
      return fileNormalizeCsv(input)
    case "file.checksumOutputs":
      return fileChecksumOutputs(input)
    case "file.summarize":
      return fileSummarize(input)
    case "build.topologicalSort":
      return buildTopologicalSort(input)
    case "build.executeTasks":
      return buildExecuteTasks(input)
    case "build.publishMarker":
      return buildPublishMarker(input)
    case "build.verifyPublish":
      return buildVerifyPublish(input)
    case "build.summarize":
      return buildSummarize(input)
    default:
      throw new Error(`No fixture operation registered for ${operation}`)
  }
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object")
  }
  return value as Record<string, unknown>
}

const asArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error("Expected array")
  }
  return value
}

const asString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Expected string")
  }
  return value
}

const asNumber = (value: unknown): number => {
  if (typeof value !== "number") {
    throw new Error("Expected number")
  }
  return value
}

const mathLoadProblems = (input: Json): Json => {
  const data = asRecord(input)
  const problemCount = asNumber(data.problemCount)
  return {
    problemIds: Array.from({ length: problemCount }, (_, index) => `p${index + 1}`),
    maxScore: problemCount
  }
}

const mathSolveProblems = (input: Json): Json => {
  const problems = asArray(asRecord(input).problems)
  return {
    answers: problems.map((problemJson) => {
      const problem = asRecord(problemJson)
      const args = asArray(problem.args).map(asNumber)
      const first = requiredNumberArg(args, 0)
      const second = args[1]
      const op = asString(problem.op)
      const answer =
        op === "add"
          ? first + (second ?? 0)
          : op === "divide"
            ? roundToTwo(first / (second ?? 1))
            : op === "sqrt"
              ? Math.sqrt(first)
              : unsupportedNumberOperation(op)
      return { problemId: asString(problem.id), answer }
    })
  }
}

const mathCheckTolerance = (input: Json): Json => {
  const data = asRecord(input)
  const problems = asArray(data.problems).map(asRecord)
  const answers = new Map(
    asArray(data.answers).map((answerJson) => {
      const answer = asRecord(answerJson)
      return [asString(answer.problemId), asNumber(answer.answer)] as const
    })
  )

  const passed: string[] = []
  const needsReview: string[] = []
  for (const problem of problems) {
    const id = asString(problem.id)
    const tolerance = typeof problem.tolerance === "number" ? problem.tolerance : 0
    const answer = answers.get(id)
    const expected = asNumber(problem.expected)
    if (answer !== undefined && Math.abs(answer - expected) <= tolerance) {
      passed.push(id)
    } else {
      needsReview.push(id)
    }
  }
  return { passed, needsReview }
}

const mathApplyReview = (input: Json): Json => {
  const data = asRecord(input)
  const signals = new Map(
    asArray(data.reviewSignals).map((signalJson) => {
      const signal = asRecord(signalJson)
      return [asString(signal.problemId), asNumber(signal.correctedAnswer)] as const
    })
  )
  const reviewedProblems: string[] = []
  const answers = asArray(data.answers).map((answerJson) => {
    const answer = asRecord(answerJson)
    const problemId = asString(answer.problemId)
    const correctedAnswer = signals.get(problemId)
    if (correctedAnswer === undefined) {
      return { problemId, answer: asNumber(answer.answer) }
    }
    reviewedProblems.push(problemId)
    return { problemId, answer: correctedAnswer }
  })
  return { answers, reviewedProblems }
}

const mathReviewTimeout = (input: Json): Json => {
  const data = asRecord(input)
  return {
    reviewedProblems: [],
    penalizedProblems: asArray(data.needsReview).map(asString),
    virtualTimeAdvancedSeconds: asNumber(data.deadlineSeconds)
  }
}

const mathGenerateReport = (input: Json): Json => {
  const data = asRecord(input)
  const batchId = asString(data.batchId)
  const penalizedProblems =
    data.penalizedProblems === undefined ? [] : asArray(data.penalizedProblems).map(asString)
  const problems = asArray(data.problems).map(asRecord)
  const answers = new Map(
    asArray(data.answers).map((answerJson) => {
      const answer = asRecord(answerJson)
      return [asString(answer.problemId), asNumber(answer.answer)] as const
    })
  )

  let score = 0
  for (const problem of problems) {
    const id = asString(problem.id)
    if (penalizedProblems.includes(id)) {
      continue
    }
    const tolerance = typeof problem.tolerance === "number" ? problem.tolerance : 0
    const answer = answers.get(id)
    if (answer !== undefined && Math.abs(answer - asNumber(problem.expected)) <= tolerance) {
      score += 1
    }
  }

  const base = {
    batchId,
    status: penalizedProblems.length > 0 ? "completed_with_penalty" : "completed",
    score,
    maxScore: asNumber(data.maxScore),
    reviewedProblems: asArray(data.reviewedProblems).map(asString)
  }

  return penalizedProblems.length > 0
    ? { ...base, penalizedProblems, reportArtifact: `memory://reports/${batchId}.json` }
    : { ...base, reportArtifact: `memory://reports/${batchId}.json` }
}

const fileDedupeEvents = (input: Json): Json => ({
  paths: [...new Set(asArray(asRecord(input).events).map(asString))]
})

const fileValidateCsvHeaders = (input: Json): Json => {
  const data = asRecord(input)
  const requiredHeaders = asArray(data.requiredHeaders).map(asString)
  const files = asRecord(data.files)
  const valid: string[] = []
  const invalid: Array<{ path: string; reason: string }> = []

  for (const [filePath, contentJson] of Object.entries(files)) {
    const content = asString(contentJson)
    const headers = content.split("\n")[0]?.split(",") ?? []
    const missing = requiredHeaders.filter((header) => !headers.includes(header))
    if (missing.length === 0) {
      valid.push(filePath)
    } else {
      invalid.push({
        path: filePath,
        reason: `missing required headers: ${requiredHeaders.join(", ")}`
      })
    }
  }

  return { valid, invalid }
}

const fileNormalizeCsv = (input: Json): Json => {
  const data = asRecord(input)
  const files = asRecord(data.files)
  const outputs = asArray(data.paths).map((pathJson) => {
    const sourcePath = asString(pathJson)
    const lines = asString(files[sourcePath]).trimEnd().split("\n")
    const headers = lines[0]?.split(",") ?? []
    const content = lines
      .slice(1)
      .map((line) => {
        const values = line.split(",")
        return JSON.stringify(
          Object.fromEntries(
            headers.map((header, index) => {
              const value = values[index] ?? ""
              const numeric = Number(value)
              return [header, Number.isFinite(numeric) && value !== "" ? numeric : value]
            })
          )
        )
      })
      .join("\n")
    return {
      path: sourcePath.replace(/^inbox\//, "done/").replace(/\.csv$/, ".ndjson"),
      content: `${content}\n`
    }
  })
  return { outputs }
}

const fileChecksumOutputs = (input: Json): Json => ({
  outputs: asArray(asRecord(input).outputs).map((outputJson) => {
    const output = asRecord(outputJson)
    const content = asString(output.content)
    return { path: asString(output.path), checksum: `len:${content.length}` }
  })
})

const fileSummarize = (input: Json): Json => {
  const data = asRecord(input)
  const runId = asString(data.runId)
  return {
    runId,
    status: "completed",
    processed: asArray(data.processed).map(asString),
    quarantined: asArray(data.invalid).map((item) => deepClone(item as Json)),
    manifest: `memory://manifests/${runId}.json`
  }
}

const buildTopologicalSort = (input: Json): Json => {
  const tasks = asArray(asRecord(input).tasks).map(asRecord)
  const byId = new Map(tasks.map((task) => [asString(task.id), task]))
  const visited = new Set<string>()
  const taskOrder: string[] = []

  const visit = (taskId: string) => {
    if (visited.has(taskId)) {
      return
    }
    const task = byId.get(taskId)
    if (task === undefined) {
      throw new Error(`Unknown task ${taskId}`)
    }
    for (const dependency of asArray(task.deps).map(asString)) {
      visit(dependency)
    }
    visited.add(taskId)
    taskOrder.push(taskId)
  }

  for (const task of tasks) {
    visit(asString(task.id))
  }
  return { taskOrder }
}

const buildExecuteTasks = (input: Json): Json => {
  const data = asRecord(input)
  const tasks = new Map(asArray(data.tasks).map((taskJson) => [asString(asRecord(taskJson).id), asRecord(taskJson)]))
  const cache = asRecord(data.cache)
  const maxAttempts = asNumber(data.maxAttempts)
  const taskResults: Json[] = []
  const artifacts: Record<string, Json> = {}

  for (const taskId of asArray(data.taskOrder).map(asString)) {
    const task = tasks.get(taskId)
    if (task === undefined) {
      throw new Error(`Unknown task ${taskId}`)
    }
    const hash = asString(task.hash)
    if (cache[hash] !== undefined) {
      artifacts[taskId] = cache[hash] as Json
      taskResults.push({ id: taskId, source: "cache" })
      continue
    }

    let attempts = 0
    for (const result of asArray(task.script).map(asString)) {
      attempts += 1
      if (result === "pass") {
        artifacts[taskId] = `artifact://${taskId}-${hash}`
        taskResults.push({ id: taskId, source: "executed", attempts })
        break
      }
      if (result !== "flaky_fail" || attempts >= maxAttempts) {
        throw new Error(`Task ${taskId} failed with ${result}`)
      }
    }
  }

  return { taskResults, artifacts }
}

const buildPublishMarker = (input: Json): Json => {
  const data = asRecord(input)
  return { releaseMarker: `memory://releases/${asString(data.buildId)}`, published: true }
}

const buildVerifyPublish = (input: Json): Json => {
  const script = asArray(asRecord(input).postPublishScript).map(asString)
  const verified = script.at(-1) === "pass"
  return { verified, rolledBack: !verified }
}

const buildSummarize = (input: Json): Json => {
  const data = asRecord(input)
  return {
    buildId: asString(data.buildId),
    status: data.verified === true ? "published" : "failed",
    releaseMarker: asString(data.releaseMarker),
    rolledBack: data.rolledBack === true
  }
}

const unsupportedNumberOperation = (operation: string): never => {
  throw new Error(`Unsupported numeric operation ${operation}`)
}

const requiredNumberArg = (args: readonly number[], index: number): number => {
  const value = args[index]
  if (value === undefined) {
    throw new Error(`Missing numeric arg at index ${index}`)
  }
  return value
}

const roundToTwo = (value: number): number => Math.round(value * 100) / 100

describe("fully specified mock workflow fixtures", () => {
  for (const workflow of fixtures.workflows) {
    for (const workflowCase of workflow.cases) {
      test(`${workflow.slug}/${workflowCase.caseId} matches every node output`, () => {
        const result = executeCase(workflowCase)

        for (const node of workflowCase.nodes) {
          expect(result.nodeOutputs.get(node.id)).toEqual(node.expectedOutput)
        }
        expect(result.finalOutput).toEqual(workflowCase.expectedOutput)
      })

      test(`${workflow.slug}/${workflowCase.caseId} replays cacheable nodes from cache`, () => {
        const prefilledCache = new Map(
          workflowCase.nodes
            .filter((node) => node.cacheable)
            .map((node) => [node.cacheKey, node.expectedOutput] as const)
        )
        const result = executeCase(workflowCase, prefilledCache)

        expect(result.cacheHits).toEqual(
          workflowCase.nodes.filter((node) => node.cacheable).map((node) => node.id)
        )
        expect(result.executedNodeIds).toEqual(
          workflowCase.nodes.filter((node) => !node.cacheable).map((node) => node.id)
        )
        expect(result.finalOutput).toEqual(workflowCase.expectedOutput)
      })
    }
  }
})
