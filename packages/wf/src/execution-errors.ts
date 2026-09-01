import { Data } from "effect"

export class StepExecutionError extends Data.TaggedError("StepExecutionError")<{
  readonly stepName: string
  readonly cause: unknown
}> {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Step ${this.stepName} failed: ${detail}`
  }
}

export class CodeExecutionError extends Data.TaggedError("CodeExecutionError")<{
  readonly name: string
  readonly cause: unknown
}> {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Code block ${this.name} failed: ${detail}`
  }
}
