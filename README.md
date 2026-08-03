# wf

An agent-first workflow platform. The agent is not the runtime — it is the
workflow *designer*. It discovers connectors, inspects their schemas and auth
requirements, composes them into durable workflows, validates them, runs them,
and inspects the resulting events. What you keep is a repeatable workflow
artifact, not an expensive LLM execution trace.

The `wf` CLI is the primary surface. Everything below is a command you can run.

- **Structured orchestration** — steps, branches, waits, retries, timeouts,
  human tasks, and signals are first-class, because the runtime has to
  understand them.
- **Typed integrations** — Executor detects MCP/OpenAPI from a URL, discovers
  auth and schemas, and invokes a stable tool address.
- **Code for computation** — mapping, formatting, and business rules stay in
  small TypeScript islands instead of a catalog of specialized nodes.

Execution is durable: every step result, timer, and signal wait is persisted in
SQLite, so runs replay deterministically and survive process restarts.

## Install

```bash
bun install -g @mokronos/wf
```

`npm install -g`, `pnpm add -g`, and `yarn global add` also work. The installed
`wf` command is a standalone platform binary — you do not need Bun to run it.

The CLI keeps its workflow catalog and durable run history under `~/.wf`. Set
`WF_HOME` to use another directory. Workflows are plain files in
`~/.wf/workflows/<id>.ts` — edit them with any editor or agent, no CLI needed.

## Quickstart: create, validate, run

### 1. Create a workflow

`wf create` with no source writes a small starter workflow into the catalog, so
you can get to a run without writing a file first:

```bash
wf create hello
```

```text
Created hello	HelloWorkflow#HelloWorkflow	/home/you/.wf/workflows/hello.ts
```

What it wrote is the workflow shown under [Authoring reference](#authoring-reference):
one typed step that prints its input. `wf create --file ./workflow.ts` imports
your own file instead.

That path is the workflow. Editing the file changes what the next run executes,
so an agent can patch a workflow with its normal file tools and `wf run` it —
`wf create --force` is only a convenience for replacing one wholesale. Runs
already in flight are unaffected: each pins the source it started with (see
[Storage](#storage)). A file exporting several workflows needs `export default`
to say which one `wf run` executes.

### 2. Validate it

`wf validate` loads the workflow, resolves its exported definition, and traces
its body in memory using sample inputs and faked steps. Nothing is executed for
real and no durable run is started — it tells you what the workflow *is* before
you commit to running it:

```bash
wf validate hello
```

```
Valid hello	HelloWorkflow#HelloWorkflow
input: {"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}
output: {"type":"null"}
flow:
  step	PrintMessage activityName="PrintMessage#1" compensates=false
```

That is the whole feedback loop for an agent: the input schema it must satisfy,
the output schema it can rely on, and the ordered flow of orchestration calls it
just authored. A broken workflow exits non-zero and prints why — here, a field
the workflow reads but never declared in its input schema:

```
Invalid broken
  - undefined is not an object (evaluating 'input.items.reduce')
```

`wf validate --file ./workflow.ts` does the same for a file that is not in the
catalog yet, so an agent can iterate on a definition before importing it.

Add `--json` for the complete machine-readable graph, and `--input '<json>'` to
trace a specific input instead of a generated sample — useful when the flow
branches.

### 3. Run it

```bash
wf run hello '{"message":"hello from wf"}'
```

```
[run] id cd0624a8-793a-44ce-9af6-b8cf75a5cbee
hello from wf
[workflow] started HelloWorkflow input={"message":"hello from wf"}
[step] started PrintMessage#1 attempt=1
[step] completed PrintMessage#1 attempt=1 result=undefined
[workflow] completed HelloWorkflow result=undefined
Workflow completed.
```

Every orchestration call streams as an event while the run progresses.

### 4. Observe it

Events are persisted, not just printed. List runs, then replay the history of
one:

```bash
wf runs
```

```
cd0624a8-793a-44ce-9af6-b8cf75a5cbee	completed	hello	2026-07-27T22:29:53.201Z	2026-07-27T22:29:53.429Z
```

```bash
wf history cd0624a8-793a-44ce-9af6-b8cf75a5cbee
```

```
1	…428Z	execution.started	{"type":"execution.started","executionId":"cd0624a8-…","workflowName":"HelloWorkflow","payload":{"message":"hello from wf"}}
2	…428Z	workflow.started	{"type":"workflow.started","workflowName":"HelloWorkflow","payload":{"message":"hello from wf"}}
3	…428Z	step.started	{"type":"step.started","executionId":"cd0624a8-…","stepName":"PrintMessage","invocation":1,"activityName":"PrintMessage#1","attempt":1,"input":{"message":"hello from wf"}}
4	…429Z	step.completed	{"type":"step.completed","executionId":"cd0624a8-…","stepName":"PrintMessage","invocation":1,"activityName":"PrintMessage#1","attempt":1}
5	…429Z	workflow.completed	{"type":"workflow.completed","workflowName":"HelloWorkflow"}
```

(Timestamps and ids abridged.) Each row is the durable record the engine
replays from — the same data the dashboard renders.

For the same data as a graph in the browser, install the local dashboard
service and open it:

```bash
wf install
wf web
```

`wf install` registers a per-user background service (`systemd --user` on Linux,
`launchd` on macOS) that serves the workflow graphs, run history, and connected
integrations from `~/.wf` at `http://127.0.0.1:4787`. It does not execute
workflows. The standalone
workflow commands also build for Windows; Windows service registration is not
implemented yet.

## Next: a workflow that calls an authorized integration

The first example never left your machine. This one connects a real service and
calls it from a workflow. Executor owns protocol detection, auth, schema
discovery, and invocation; the workflow stores only a tool address.

### 1. Discover the integration

```bash
wf integrations discover https://mcp.linear.app/mcp
```

This performs the complete discovery chain:

`URL → protocol detection → integration registration → auth discovery →
connection (when public) → tool names and input/output schemas`.

If auth is required, the result includes the available auth templates and the
integration slug to connect.

### 2. Authorize it in the browser

```bash
wf i connect <integration-slug>
```

For OAuth, Executor discovers authorization metadata, dynamically registers a
client when supported, and runs authorization code + PKCE against a loopback
callback. Add `--no-open` to print the URL instead of launching a browser. For
API keys and bearer tokens, use `--credential-env NAME`; the secret value is not
printed. When `--scopes` is provided, those exact scopes replace the provider's
discovered defaults in the authorization request.

Confirm it landed, and see every connection you hold:

```bash
wf i connections
```

### 3. Inspect the operations you can call

```bash
wf i tools <integration-slug>
```

This returns JSON with tool names, addresses, descriptions, and complete input
and output JSON Schemas. Use `--text` for concise human-readable output. Pick an address and
mirror its schema in the workflow's `input` and `output`.
Generic MCP envelopes are normalized before they reach workflows: structured
content is returned directly, JSON text is parsed, and plain text remains a
string.

Safely inspect a read-only tool before authoring:

```bash
wf i invoke <tool-address> '{"query":"workflow integrations"}'
```

> Linear does not publish a stable list of MCP tool names, so the address and
> field names below are illustrative. Replace them with the exact tool output.

### 4. Author the workflow

Save this as `linear-issue.ts`. The only integration identity persisted in the
workflow is its Executor address:

```ts
import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const createIssue = integration({
  name: "CreateLinearIssue",
  source: {
    kind: "executor",
    address: "tools.linear.org.default.create_issue"
  },
  input: t.struct({ team: t.string, title: t.string, description: t.string }),
  output: t.struct({ id: t.string, identifier: t.string, url: t.string }),
  retry: { attempts: 3, backoff: "exponential" }
})

const NotApproved = t.taggedStruct("NotApproved", { reason: t.string })

export const LinearIssueWorkflow = defineWorkflow({
  name: "LinearIssueWorkflow",
  input: t.struct({ team: t.string, title: t.string, detail: t.string }),
  output: t.struct({ identifier: t.string, url: t.string }),
  errors: NotApproved,
  run: function* (input, ctx) {
    // Plain TypeScript, made durable and visible as a node in the graph.
    const description = yield* ctx.code("build-description", {
      reason: "Give the reviewer the full issue body before it is filed",
      run: () => `${input.detail}\n\nFiled by wf.`
    })

    // Suspend until a human approves. The process can exit here and resume later.
    const approval = yield* ctx.waitForSignal(
      "fileIssue",
      t.struct({ approved: t.boolean }),
      { timeout: "1 hour" }
    )
    if (approval.type === "timeout" || !approval.value.approved) {
      return yield* ctx.fail({ _tag: "NotApproved", reason: "issue was not approved" })
    }

    const issue = yield* ctx.run(createIssue, {
      team: input.team,
      title: input.title,
      description
    })
    return { identifier: issue.identifier, url: issue.url }
  }
})
```

### 5. Import and validate it

```bash
wf create linear-issue --file ./linear-issue.ts
wf validate linear-issue
```

```
Valid linear-issue	LinearIssueWorkflow#LinearIssueWorkflow
input: {"type":"object","properties":{"team":{"type":"string"},"title":{"type":"string"},"detail":{"type":"string"}},…}
output: {"type":"object","properties":{"identifier":{"type":"string"},"url":{"type":"string"}},…}
errors: {"type":"object","properties":{"_tag":{"type":"string","enum":["NotApproved"]},"reason":{"type":"string"}},…}
flow:
  code	build-description reason="Give the reviewer the full issue body before it is filed"
  signal	fileIssue timeout="1 hour"
  step	CreateLinearIssue activityName="CreateLinearIssue#1" retry={"attempts":3,"backoff":"exponential"} compensates=false
```

Validation never calls Linear — integration steps are faked during the trace —
so this is safe to run in a loop while you repair the definition.

### 6. Run it

```bash
wf run linear-issue '{"team":"ENG","title":"Durable workflows","detail":"Try wf"}'
```

The run suspends at the approval and tells you exactly how to resume it:

```
[run] id 04dc7f53-ae35-44d0-98aa-df86832cbe51
[workflow] started LinearIssueWorkflow input={"team":"ENG","title":"Durable workflows","detail":"Try wf"}
[code] started build-description#1 reason="Give the reviewer the full issue body before it is filed"
[code] completed build-description#1 reason="Give the reviewer the full issue body before it is filed" result="Try wf\n\nFiled by wf."
[signal] waiting fileIssue#1
[signal] waiting for fileIssue timeout="1 hour"
[signal] fileIssue expects payload schema: {"type":"object","properties":{"approved":{"type":"boolean"}},"required":["approved"],"additionalProperties":false}
Resume with: wf signal 04dc7f53-ae35-44d0-98aa-df86832cbe51 fileIssue '{"approved":true}'
```

The command exits 0; the run stays suspended in SQLite. Resume it from any
terminal, even after a reboot:

```bash
wf signal 04dc7f53-ae35-44d0-98aa-df86832cbe51 fileIssue '{"approved":true}' --actor you
```

Only then does the workflow reach the integration step. Executor resolves the
connection and invokes the tool; credentials are never written into workflow
source or durable history.

## Command reference

```bash
wf <command>
```

| Command | Purpose |
| --- | --- |
| `wf create` | Create or import a workflow file into the catalog |
| `wf validate` | Load and trace a workflow without running it |
| `wf list` | List workflow files and their paths |
| `wf run` | Start a run and stream its events |
| `wf runs` | List persisted runs |
| `wf history` / `wf events` | Show the persisted event history for a run |
| `wf signal` | Resume a run waiting for a signal |
| `wf integrations` / `wf i` | Discover, authorize, inspect, and validate integrations |
| `wf install` | Install the local dashboard service |
| `wf web` | Open the local dashboard |
| `wf daemon` | Run the dashboard service in the foreground |

Run `wf --help` or `wf <command> --help` for arguments, flags, examples, and
nested subcommands.

### Integration commands

All integration commands also accept the shorter `wf i` alias.

```text
wf i
├── search
├── discover
├── catalog
├── connect
├── connections
├── tools
├── disconnect
├── invoke
└── validate
```

`search` returns JSON by default with exact catalog and surface URLs; use `--text`
for a readable result. `discover` uses Executor to identify MCP or OpenAPI,
register the integration, discover auth, and list the number of available tools.
After `connect`, `tools` returns JSON by default with complete schemas; use
`--text` for concise canonical addresses and input shapes. The default connection is `default`. `validate <tool-address>` checks
an authored address against the live catalog. `invoke` executes one tool directly
and prints its normalized JSON result.

The dashboard's **Integrations** view (`wf web`) shows the same catalog in the
browser: which integrations are connected, the connections authorizing them, and
every tool with its input and output schema.

### Storage

- `~/.wf/workflows/<id>.ts` — the workflow catalog. One editable file per
  workflow, and the only authority for its source. The workflow's name and
  exported symbol are read from the file, never stored beside it.
- `~/.wf/sources/<sha256>.ts` — the source each run started against, written
  when the run starts and never modified. A run parked on a signal resumes
  against its snapshot, which is what lets you edit a workflow while it is in
  flight.
- `~/.wf/engine.sqlite` — durable engine state: completed step results, timers,
  suspended signal waits.
- `~/.wf/executor.sqlite` — Executor integration, connection, and tool metadata.
- `~/.wf/executor-auth.json` — AES-GCM-encrypted credentials.
- `~/.wf/executor-auth.key` — user-only local encryption key.

## Authoring reference

Workflows are plain TypeScript. They import only from `@mokronos/wfkit` — never
from `effect` directly — which is what lets the CLI load a stored artifact
without a build step.

```bash
bun add @mokronos/wfkit
```

A step is the unit of durable side effects: retried on thrown errors, its result
persisted so replays never re-execute it. A workflow is a generator that yields
orchestration calls.

```ts
import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const printMessage = defineStep({
  name: "PrintMessage",
  input: t.struct({ message: t.string }),
  output: t.void,
  execute: async (input) => {
    console.log(input.message)
  }
})

export const HelloWorkflow = defineWorkflow({
  name: "HelloWorkflow",
  input: t.struct({ message: t.string }),
  output: t.void,
  run: function* (input, ctx) {
    yield* ctx.run(printMessage, { message: input.message.trim() })
  }
})
```

### Orchestration calls

| Call | Meaning |
| --- | --- |
| `ctx.run(step, input)` | Durable step call; result persisted, replays skip re-execution |
| `ctx.code(name, { reason, run })` | Pure TypeScript as a first-class, journaled node |
| `ctx.sleep(duration, name)` | Durable timer that survives process restarts |
| `ctx.waitForSignal(name, schema, { timeout })` | Suspend until an external signal arrives |
| `ctx.all([...], { name, concurrency })` | Parallel composition, tuple-typed like `Promise.all` |
| `ctx.now()` / `ctx.random()` | Recorded so replays observe the same values |
| `ctx.fail(error)` | Typed workflow failure; compensations run in reverse order |

`ctx.code` return values must be JSON-serializable. Keep `run` free of external
side effects; use `defineStep` for IO, service calls, and anything needing
retries or compensation.

### Steps in depth

[examples/quickstart/order.ts](examples/quickstart/order.ts) exercises typed
errors, retries, concurrency limits, compensation, deterministic time and
randomness, durable sleeps, and signals in one workflow:

```ts
const chargeCard = defineStep({
  name: "ChargeCard",
  input: t.struct({ orderId: t.string, amount: t.number }),
  output: t.struct({ paymentId: t.string }),
  errors: PaymentDeclined,
  retry: { attempts: 3, backoff: "none" },
  concurrency: { limit: 5 },
  execute: async (input, step) => {
    if (step.attempt < 2) {
      throw new Error("payment gateway flaked") // thrown errors are transient -> retried
    }
    if (input.amount <= 0) {
      return step.fail({ _tag: "PaymentDeclined", orderId: input.orderId }) // terminal -> never retried
    }
    console.log(`charged order ${input.orderId} on attempt ${step.attempt}`)
    return { paymentId: `pay_${input.orderId}` }
  },
  // Runs in reverse order if a later part of the workflow fails.
  compensate: async (result) => {
    console.log(`refunding ${result.paymentId}`)
  }
})
```

```bash
bun run example:quickstart
```

Other runnable examples: [examples/email](examples/email) (`bun run
example:email`), [examples/order-saga](examples/order-saga) (`bun run
example:order-saga`), [examples/approval](examples/approval) (`bun run
example:approval`), and [examples/connected-case](examples/connected-case), the
integration acceptance case covering OpenAPI, OAuth-protected MCP, and a
cross-process approval.

### Parallel composition

```ts
const [payment, inventory] = yield* ctx.all([
  ctx.run(chargeCard, input),
  ctx.run(reserveInventory, input)
], { name: "reserve-order", concurrency: "unbounded" })
```

The durable engine runs branches with Effect concurrency and persists activity
results by activity name, so completion order does not affect replay. The
in-memory runner executes branches sequentially in array order; it is optimized
for tests and graph tracing, where deterministic branch boundaries matter more
than actual parallelism.

Each branch should be a single pre-built orchestration call such as `ctx.run`,
`ctx.code`, `ctx.sleep`, or `ctx.waitForSignal`. Building additional `ctx.*`
calls dynamically inside a branch, for example with `Effect.flatMap`, assigns
invocation counters during interleaved durable execution and is not replay-safe
yet. Sequencing inside a branch will be modeled with child workflows later.

Inside a durable `ctx.all`, replay checks use call identity instead of global
journal position, because concurrent branches can interleave differently across
runs. This still verifies matching branch calls by kind, name, counter, and the
outer `ctx.all` branch count, but divergence detection inside parallel blocks is
coarser than in sequential workflow code.

### Embedding the engine

The CLI is the intended entry point, but the same runtime is available directly
([examples/quickstart/main.ts](examples/quickstart/main.ts)):

```ts
import { createWorkflowClient, createWorkflowRuntime } from "@mokronos/wfkit"
import { OrderWorkflow } from "./order"

const runtime = createWorkflowRuntime({ backend: "sqlite", databasePath: ".wf/quickstart.sqlite" })
runtime.register([OrderWorkflow])
const client = createWorkflowClient(runtime)

const handle = await client.start(OrderWorkflow, { orderId: "123", amount: 42 })

// Signals are only accepted once the run is actually waiting for them; the
// example polls client.history() for the signal.waiting event before sending.
await client.signal(handle.executionId, "managerApproval", { approved: true }, { actor: "manager" })
console.log("result:", await client.result(handle.executionId))
```

The client also exposes `status`, `history`, `pendingSignals`, and cancellation.
Because all engine state lives in SQLite, a new process pointed at the same
database can deliver a signal and resume a suspended execution.

### Testing workflows

`createTestRuntime` (from `@mokronos/wfkit/testing`) and
`workflow.executeInMemory` run workflows without the engine, with hooks to fake
steps, sleeps, signal timeouts, and secrets. `deliverSignal(executionId, name,
payload)` feeds signals to in-memory executions.

```bash
bun test
```

## Development

```bash
bun run typecheck
bun test
bun run verify   # typecheck, tests, examples, and all builds
```
