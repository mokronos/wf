# wf CLI

`wf` is the primary surface: durable workflows and a local dashboard. It is
installed as a standalone platform binary, so Bun is not required to run it.

```bash
bun install -g @mokronos/wf
wf --help
```

```text
wf
├── create
├── validate
├── list
├── run
├── runs
├── history (alias: events)
├── signal
├── install
├── web
└── daemon
```

## Global flags

Every command accepts these:

| Flag | Meaning |
| --- | --- |
| `--help`, `-h` | Show help for the command |
| `--version` | Show the CLI version |
| `--completions <bash\|zsh\|fish\|sh>` | Print a shell completion script |
| `--log-level <level>` | Minimum log level: `all`, `trace`, `debug`, `info`, `warn`, `warning`, `error`, `fatal`, `none` |

Output is **progressive** by default: collection commands show at most 10
workflow records, validation and execution print summaries, and large results
are previewed. Add `--verbose` (`-v`) for complete details. Explicit
machine-readable modes such as `wf validate --json` are always lossless.

## Environment

| Variable | Effect |
| --- | --- |
| `WF_HOME` | Directory for the workflow catalog, run history, and engine state. Defaults to `~/.wf` |

## wf create

Create or import a workflow file into the local catalog.

```text
wf create [flags] <workflow-id>
```

| Flag | Meaning |
| --- | --- |
| `--name <string>` | Name the workflow in a generated template |
| `--source <string>` | Import inline TypeScript source |
| `--file <path>` | Import TypeScript from a file |
| `--force` | Replace an existing workflow id |
| `--verbose`, `-v` | Show complete details |

```bash
wf create welcome-email
wf create email --file workflows/email.ts
```

With no `--file`/`--source`, a starter workflow is generated. The result is a
plain file at `~/.wf/workflows/<id>.ts`; editing it changes what the next run
executes, so `--force` is only a convenience for replacing one wholesale. Runs
already in flight are unaffected — each pins the source snapshot it started
against.

## wf validate

Load and trace a workflow without starting a durable run.

```text
wf validate [flags] [<workflow-id>]
```

| Flag | Meaning |
| --- | --- |
| `--file <path>` | Validate a TypeScript workflow file outside the catalog |
| `--input <json>` | Use this JSON value while tracing, instead of a generated sample |
| `--json` | Print the complete validation graph as JSON |
| `--verbose`, `-v` | Show complete details |

```bash
wf validate welcome-email
wf validate --file workflows/email.ts --json
wf validate orders --input '{"orderId":"1842","amount":42}'
```

Validation traces the workflow body in memory with faked steps and records no
run, so it is safe to use in a repair loop. Use `--input` when the flow branches
on a value.

It reports the workflow's input, output, and error schemas and the ordered flow
of orchestration calls. The exit code is non-zero while the workflow is invalid.

## wf list

List workflow files in the local catalog, with modification times and paths.

```text
wf list [--verbose]
```

## wf run

Start a registered workflow run and stream its events.

```text
wf run [flags] <workflow-id> [<json-input>]
```

```bash
wf run welcome-email
wf run welcome-email '{"message":"hello"}'
```

Each orchestration call streams as it happens (`[step]`, `[code]`, `[signal]`,
`[workflow]`). If the workflow suspends on a signal, the command prints the
expected payload schema and the exact command to resume it, then exits 0 — the
run stays suspended in SQLite:

```text
[signal] waiting for fileIssue timeout="1 hour"
[signal] fileIssue expects payload schema: {"type":"object","properties":{"approved":{"type":"boolean"}},...}
Resume with: wf signal 04dc7f53-... fileIssue '{"approved":true}'
```

## wf runs

List persisted workflow runs — id, status, workflow, start and end times.

```text
wf runs [--verbose]
```

## wf history

Show the persisted event history for a run. Also available as `wf events`.

```text
wf history [flags] <run-id>
```

```bash
wf history cd0624a8-793a-44ce-9af6-b8cf75a5cbee
```

Each row is the durable record the engine replays from — the same data the
dashboard renders.

## wf signal

Resume a run waiting for a signal.

```text
wf signal [flags] <run-id> <signal-name> [<json-payload>]
```

| Flag | Meaning |
| --- | --- |
| `--actor <string>` | Record who delivered the signal |
| `--verbose`, `-v` | Show complete details |

```bash
wf signal 04dc7f53-ae35-44d0-98aa-df86832cbe51 fileIssue '{"approved":true}' --actor you
```

The payload is validated against the schema the workflow declared in
`ctx.waitForSignal`. Because all engine state lives in SQLite, any terminal on
the machine can deliver the signal — including after a reboot.

## wf install

Register and start the per-user local dashboard service.

```text
wf install [--verbose]
```

`systemd --user` on Linux, `launchd` on macOS. The service serves workflow
graphs and run history from `~/.wf` at
`http://127.0.0.1:4787`; it does not execute workflows. Windows service
registration is not implemented yet.

The background service keeps running the code it started with — after upgrading
or editing sources, run `wf install` again to restart it.

## wf web

Open the installed local dashboard.

```text
wf web [flags]
```

| Flag | Meaning |
| --- | --- |
| `--foreground` | Run a temporary dashboard in this terminal instead of using the service |
| `--port <integer>` | Dashboard port when running in the foreground |
| `--no-open` | Do not open a browser |

## wf daemon

Run the dashboard service in the foreground — what the installed service unit
executes.

```text
wf daemon [--foreground] [--port <integer>]
```
