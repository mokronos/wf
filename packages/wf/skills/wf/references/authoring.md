# wf authoring reference

Read this when creating or modifying a workflow file.

## Artifact contract

- Import named APIs only from `@mokronos/wfkit`. Do not import `effect`, package
  subpaths, relative helpers, or arbitrary dependencies in a stored artifact.
- Keep the file self-contained. Export one named workflow, or use a default
  export if the file contains multiple workflows.
- Workflow `run` is a deterministic generator, `function*`, not `async`.
- External IO belongs in `defineStep` or `integration`, never directly in
  `run`. Use `ctx.now()` and `ctx.random()`, never `Date.now()` or
  `Math.random()`.
- `ctx.code` is for small pure computations. It requires `reason`, `output`, and
  `run`; its callback executes during validation.
- Use stable, descriptive names. Changing orchestration order or identity can
  make an in-flight replay nondeterministic.

## Schemas

The supported vocabulary is:

```ts
t.string
t.number
t.boolean
t.void
t.date
t.unknown
t.struct({ field: t.string })
t.array(t.string)
t.literal("value")
t.taggedStruct("Tag", { reason: t.string })
t.optional(t.string)
t.union([First, Second])
```

Mirror a tool's actual schema from `wf i schema`; never infer it from the tool
name. Integration input must be JSON-compatible. Generic MCP results are
normalized before output decoding, so use the normalized output schema shown by
the CLI and confirmed by a safe invocation when possible.

## Integration and parallel template

Replace both addresses and all schemas with values returned by the CLI:

```ts
import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const LookupResult = t.struct({ value: t.string })
const DetailResult = t.struct({ detail: t.string })

const lookup = integration({
  name: "Lookup",
  source: {
    kind: "executor",
    address: "tools.service-a.org.default.lookup"
  },
  input: t.struct({ query: t.string }),
  output: LookupResult,
  retry: { attempts: 3, backoff: "exponential" }
})

const details = integration({
  name: "Details",
  source: {
    kind: "executor",
    address: "tools.service-b.org.default.details"
  },
  input: t.struct({ topic: t.string }),
  output: DetailResult
})

export const ResearchWorkflow = defineWorkflow({
  name: "ResearchWorkflow",
  input: t.struct({ query: t.string, topic: t.string }),
  output: t.struct({ summary: t.string }),
  run: function* (input, ctx) {
    const [found, explained] = yield* ctx.all([
      ctx.run(lookup, { query: input.query }),
      ctx.run(details, { topic: input.topic })
    ], { name: "collect-research", concurrency: 2 })

    return yield* ctx.code("summarize-research", {
      reason: "Combine both persisted integration results deterministically",
      output: t.struct({ summary: t.string }),
      run: () => ({ summary: `${found.value}: ${explained.detail}` })
    })
  }
})
```

`ctx.all` is the parallel primitive; there is no `parallel()` or `ctx.parallel`.
Each branch must be one pre-built orchestration call such as `ctx.run` or
`ctx.code`. Do not sequence more `ctx.*` calls inside a parallel branch.

## Other primitives

```ts
const value = yield* ctx.run(step, input)
yield* ctx.sleep("5 minutes", "wait-before-retry")
const now = yield* ctx.now()
const random = yield* ctx.random()

const decision = yield* ctx.waitForSignal(
  "approval",
  t.struct({ approved: t.boolean, reviewer: t.string }),
  { timeout: "24 hours" }
)

if (decision.type === "timeout" || !decision.value.approved) {
  return yield* ctx.fail({ _tag: "Rejected", reason: "not approved" })
}
```

Use plain deterministic TypeScript for branches and loops. Signal timeouts are
values, not thrown errors. Avoid parallel waits sharing one public signal name.

## Steps, errors, and compensation

```ts
const Failed = t.taggedStruct("Failed", { reason: t.string })

const performAction = defineStep({
  name: "PerformAction",
  input: t.struct({ id: t.string }),
  output: t.struct({ resultId: t.string }),
  errors: Failed,
  retry: { attempts: 3, backoff: "exponential" },
  execute: async (input, step) => {
    if (input.id.length === 0) {
      return step.fail({ _tag: "Failed", reason: "id is empty" })
    }
    return { resultId: input.id }
  },
  compensate: async (result) => {
    // Undo the completed action idempotently.
    console.log(`undo ${result.resultId}`)
  }
})
```

- Thrown step errors are transient and follow retry policy. Return
  `step.fail(...)` for declared terminal business failures; do not throw it.
- `attempts` is total attempts. Backoff is `"none"` or `"exponential"`.
- Declare the workflow's business-error schema explicitly; step errors are not
  automatically aggregated.
- Successful compensatable steps unwind in reverse order after a later failure.
  Compensation is not retried, so make it idempotent.
- `integration(...)` does not support compensation. Design write workflows and
  rollback behavior deliberately.

## Validation limits

- `wf validate` transpiles and evaluates; it does not run TypeScript typecheck.
- It traces one input-dependent path with generated step/integration outputs.
  Validate each important branch with `--input`.
- It fakes `defineStep.execute`, integration calls, sleeps, and signal delivery,
  but runs module scope and `ctx.code`; keep those safe.
- It does not prove that a tool is installed or connected. Live-validate every
  address with `wf i validate <tool-address> --text`.
- An unbounded loop can hang validation. Keep all orchestration loops bounded by
  validated input or persisted results.
