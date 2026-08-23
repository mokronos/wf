# wf authoring reference

Read this when creating or modifying a workflow file.

## Artifact contract

- Import named APIs only from `@mokronos/wfkit`. Do not import package subpaths,
  relative helpers, or arbitrary dependencies in a stored artifact.
- Keep the file self-contained. Export one named workflow, or use a default
  export if the file contains multiple workflows.
- Workflow `run` is a deterministic generator, `function*`, not `async`.
- External IO belongs in `defineStep`, never directly in `run`.
- Use `ctx.now()` and `ctx.random()`, never `Date.now()` or `Math.random()`.
- `ctx.code` is for small pure computations. It requires `reason`, `output`, and
  `run`; its callback executes during validation.
- Use stable, descriptive names. Changing orchestration order or identity can
  make an in-flight replay nondeterministic.

## Schemas

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

## Primitives

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
```

Use plain deterministic TypeScript for branches and loops. Signal timeouts are
values, not thrown errors. Avoid parallel waits that share one public signal
name. `ctx.all` accepts pre-built orchestration calls; do not create further
`ctx.*` calls inside a parallel branch.

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
    console.log(`undo ${result.resultId}`)
  }
})
```

- Thrown step errors are transient and follow the retry policy. Return
  `step.fail(...)` for declared terminal business failures.
- `attempts` is the total number of attempts. Backoff is `"none"` or
  `"exponential"`.
- Successful compensatable steps unwind in reverse order after a later failure.
  Compensation is not retried, so make it idempotent.

## Validation limits

- `wf validate` transpiles and evaluates; it does not run TypeScript typecheck.
- It traces one input-dependent path with generated step outputs. Validate every
  important branch with `--input`.
- It fakes step execution, sleeps, and signal delivery, but runs module scope and
  `ctx.code`; keep those safe.
- Bound orchestration loops by validated input or persisted results.
