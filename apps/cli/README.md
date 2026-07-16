# wf CLI

The CLI is a local client over the `wf` SDK. It manages workflow artifacts,
executes them through the workflow engine, and records run metadata/events in
SQLite.

Run it from the repository root:

```bash
bun run cli -- <command>
```

## Storage

The CLI uses these local files:

- `.wf/wf.sqlite`: workflow catalog, run rows, and run event rows.
- `.wf/engine.sqlite`: internal durable workflow engine state.

Workflow engine state is stored directly in SQLite through the SQL-backed
`SingleRunner` layer. Completed activities and durable workflow messages are
written to `.wf/engine.sqlite` by the engine.

Workflow source is stored in the workflow catalog. Files are only a CLI
convenience for importing source with `--file`; the runtime does not load
workflow definitions from their original file path.

## Commands

### `wf create`

Create or import a TypeScript workflow and register it in the SQLite catalog.

```bash
bun run cli -- create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]
```

Examples:

```bash
bun run cli -- create welcome-email
bun run cli -- create invoice-sync --file workflows/invoice-sync.ts --version v1
bun run cli -- create inline-demo --source 'import { defineWorkflow, t } from "wf"; export const InlineDemoWorkflow = defineWorkflow({ name: "InlineDemoWorkflow", payload: { message: t.string } }, function* (input, ctx) { yield* ctx.step("Echo", () => input.message) })'
```

Defaults:

- `--name`: detected from the source — the CLI loads the module and stores the
  actual workflow export. When the file exports several workflows, pass
  `--name` to pin one. Without `--source`/`--file`, the starter workflow is
  named PascalCase id plus `Workflow` (`welcome-email` becomes
  `WelcomeEmailWorkflow`).
- no `--source` / `--file`: a starter workflow is generated and stored directly.
- `--version`: `dev`.

Use `--force` to update an existing workflow id.

What happens:

- With no `--source` or `--file`, the CLI generates a starter workflow and stores
  that TypeScript source in `.wf/wf.sqlite`. The starter workflow expects
  `{ "message": "hello" }` input.
- With `--file`, the CLI reads that file once and stores its source in
  `.wf/wf.sqlite`. Later runs use the stored source, not the file path.
- With `--source`, the CLI stores the provided TypeScript source directly.
- The source is loaded at create time to resolve and validate the workflow
  export, so a file that does not export a wf workflow fails immediately.
- If the id already exists, the command fails unless `--force` is passed;
  `--force` replaces every catalog row stored under that id.

Saved workflows should be self-contained modules that import only from `wf`,
expose a named workflow export, and avoid relative imports. The default starter
workflow starts with a simple `message: string` payload.

### `wf list`

List registered workflows.

What happens: reads workflow artifacts from `.wf/wf.sqlite` and prints their id,
version, workflow export, and stored source size. It does not run workflow code.

```bash
bun run cli -- list
```

Output columns:

```txt
id  version  name#exportName  source-size
```

### `wf run`

Run a registered workflow by id with optional JSON input.

```bash
bun run cli -- run <workflow-id> [json-input]
```

Examples:

```bash
bun run cli -- run welcome-email '{"message":"hello"}'
bun run cli -- run email '{"id":"123","to":"hello@example.com"}'
```

During execution, workflow events are printed to stderr:

- workflow started/completed/failed
- step started/completed
- activity started/completed/failed
- sleep started/completed
- signal waiting/received/completed

The final workflow result is printed to stdout. The deterministic run id is
printed to stderr.

If the workflow suspends waiting for a signal, `wf run` syncs events recorded so
far, leaves the run row in `running` status, prints the pending signal name and a
copy-pasteable `wf signal` command, then exits 0. Durable sleeps continue to wait
inside the run process; only signal waits cause this early exit.

What happens:

- The CLI loads the workflow artifact by id from `.wf/wf.sqlite`.
- The stored TypeScript source is transpiled and imported.
- The JSON input is validated by the workflow's declared payload schema.
- A deterministic run id is recorded in `.wf/wf.sqlite`.
- The workflow executes through the durable engine, which stores engine state in
  `.wf/engine.sqlite`.
- Workflow events are appended to `.wf/wf.sqlite` as the run progresses.

### `wf signal`

Deliver a signal to a suspended workflow run.

```bash
bun run cli -- signal <run-id> <signal-name> [json-payload] [--actor <actor>]
```

Examples:

```bash
bun run cli -- signal 018f6c7c-4c3b-7f12-91c8-88560b4b21a9 approval '{"approved":true}'
bun run cli -- signal 018f6c7c-4c3b-7f12-91c8-88560b4b21a9 approval '{"approved":true}' --actor ops
```

What happens:

- The CLI finds the run row in `.wf/wf.sqlite` and reloads the stored workflow
  artifact.
- The workflow is registered in a fresh SQLite runtime pointing at the same
  `.wf/engine.sqlite` file.
- The signal payload is delivered to the durable engine.
- The signaling process drives the execution until it completes, fails, or
  suspends again waiting for another signal.
- New engine history is copied into `.wf/wf.sqlite` without duplicating events.

If the workflow completes, the result is printed to stdout and the run row is
marked `completed`. If it suspends on another signal, the command prints the next
pending signal hint and exits 0.

### `wf runs`

List persisted workflow runs.

What happens: reads run rows from `.wf/wf.sqlite`. It does not resume or execute
any workflow code.

```bash
bun run cli -- runs
```

Output columns:

```txt
run-id  status  workflow@version  started-at  finished-at
```

### `wf events`

List persisted events for a run.

What happens: reads recorded event rows for one run id from `.wf/wf.sqlite`. It
does not replay the workflow.

```bash
bun run cli -- events <run-id>
```

Output columns:

```txt
sequence  created-at  event-type  event-json
```

### `wf help`

Print command help.

What happens: prints usage text only. It does not read or write workflow state.

```bash
bun run cli -- help
```
