# wf

To install dependencies:

```bash
bun install
```

To run the example directly:

```bash
bun run example:email
```

## CLI walkthrough

The CLI stores workflow source code in a local SQLite catalog and then runs that
stored source through the workflow engine. It does not just create a name or an
empty placeholder.

Run these commands from the repository root.

### Create a generated starter workflow

```bash
bun run cli -- create welcome-email
```

This creates a workflow artifact with id `welcome-email` in `.wf/wf.sqlite`.
Because no `--file` or `--source` is provided, the CLI generates a small starter
workflow for you and stores that TypeScript source in the catalog. The generated
workflow is named `WelcomeEmailWorkflow` and expects this payload shape:

```json
{ "message": "hello" }
```

That is why it can be run immediately:

```bash
bun run cli -- run welcome-email '{"message":"hello"}'
```

### Import the email example workflow

```bash
bun run cli -- create email --file examples/email/email.ts
```

This creates or imports a different workflow artifact with id `email`. Instead
of generating starter source, the CLI reads `examples/email/email.ts` and stores
that source in `.wf/wf.sqlite`.

The example email workflow is not the same as `welcome-email`. It expects this
payload shape:

```json
{ "id": "123", "to": "hello@example.com" }
```

Run it with:

```bash
bun run cli -- run email '{"id":"123","to":"hello@example.com"}'
```

Running `email` with `{ "message": "hello" }` fails validation because the
stored `EmailWorkflow` requires `id` and `to`.

### Inspect stored workflows and runs

```bash
bun run cli -- list
bun run cli -- runs
bun run cli -- events '<run-id>'
```

`list` shows the workflow artifacts stored in `.wf/wf.sqlite`. `runs` shows
persisted workflow executions. `events <run-id>` shows the workflow, step,
activity, sleep, and signal events recorded for a specific run.

See [apps/cli/README.md](apps/cli/README.md) for the full CLI reference.

`wf run` prints workflow events for steps, activities, sleeps, and signals to
stderr while leaving the final result on stdout.

Workflow source, catalog rows, run rows, and event rows are stored in
`.wf/wf.sqlite`. Files are only a CLI convenience for importing workflow source
with `wf create --file`.

The Effect workflow engine uses `.wf/engine.sqlite` directly through the
SQL-backed `SingleRunner` layer, so completed activity results and durable
workflow messages are stored in SQLite as the engine runs.

This project was created using `bun init` in bun v1.3.12. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
