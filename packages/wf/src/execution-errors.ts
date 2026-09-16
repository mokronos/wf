import { Schema } from "effect"

export class StepExecutionError extends Schema.TaggedError<StepExecutionError>()(
  "StepExecutionError",
  {
    stepName: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Step ${this.stepName} failed: ${detail}`
  }
}

export class CodeExecutionError extends Schema.TaggedError<CodeExecutionError>()(
  "CodeExecutionError",
  {
    name: Schema.String,
    cause: Schema.Defect()
  }
) {
  override get message(): string {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Code block ${this.name} failed: ${detail}`
  }
}
