> **[Use with your agent →](https://github.com/mokronos/wf/blob/main/packages/wf/GUIDE.md)** Copy the guide into your chat so your agent can install wfkit and run a real workflow for you.

# @mokronos/wfkit

@mokronos/wfkit is the Bun-first SDK for authoring and running durable workflows in plain TypeScript. Workflows have typed inputs, outputs, and errors; the engine (built on `@effect/workflow`) persists every step result, timer, and signal wait in SQLite, so executions replay deterministically and survive process restarts.

```sh
bun add @mokronos/wfkit
```

```ts
import { defineStep, defineWorkflow, run, t } from "@mokronos/wfkit"

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
    yield* ctx.run(printMessage, {
      message: input.message.trim()
    })
  }
})

run(HelloWorkflow, { message: "hello from @mokronos/wfkit" })
```

Subpath exports: `@mokronos/wfkit/schemas` (shared Effect schemas) and `@mokronos/wfkit/testing` (test helpers).

## Executor integrations

`integration(...)` is one durable node backed by an Executor tool address.
Executor owns MCP/OpenAPI protocol handling, auth connections, schema discovery,
and invocation. The workflow stores only the address. Discovery and connection
management are provided by the separate `@mokronos/wfkit-executor` package and
the `wf` CLI; authored workflows only need `@mokronos/wfkit`.

```ts
import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const CreatedIssue = t.struct({ id: t.string, title: t.string })

const createIssue = integration({
  source: {
    kind: "executor",
    address: "tools.linear.org.default.create_issue"
  },
  input: t.struct({ teamId: t.string, title: t.string }),
  output: CreatedIssue
})

export const CreateIssue = defineWorkflow({
  name: "CreateIssue",
  input: t.struct({ teamId: t.string, title: t.string }),
  output: CreatedIssue,
  run: function* (input, ctx) {
    return yield* ctx.run(createIssue, input)
  }
})
```

Start with one URL. The discovery command runs detection, auth discovery,
registration, and tool-schema discovery:

```sh
wf i discover https://mcp.example.com/mcp
wf i connect <integration-slug>
wf i tools <integration-slug>
wf i invoke <tool-address> '{"query":"status"}'
wf i connections
```

The default connection is `default`. Integration commands return JSON by default;
use `--text` for human-readable output.

For API keys or bearer tokens, pass the name of an environment variable with
`--credential-env`; the value is never printed. OAuth uses Executor's discovery,
dynamic registration when supported, PKCE, token refresh, and a loopback
callback. Credentials are AES-GCM encrypted in `~/.wf/executor-auth.json` using
the user-only `~/.wf/executor-auth.key`; they are not written to workflow source
or durable history.

## CLI

The CLI is distributed separately as `@mokronos/wf` and installs a global,
standalone `wf` command:

```sh
bun install --global @mokronos/wf
wf install
wf web
```

Use `wf` for the full lifecycle:

```text
wf
├── create
├── validate
├── list
├── run
├── runs
├── history (alias: events)
├── signal
├── integrations (alias: i)
│   ├── discover
│   ├── catalog
│   ├── connect
│   ├── connections
│   ├── tools
│   ├── disconnect
│   ├── invoke
│   └── validate
├── install
├── web
└── daemon
```

Use `wf --help` or `wf <command> --help` for arguments, flags, examples, and
nested subcommands.

Workflows are editable files in `~/.wf/workflows/<id>.ts`, with the source each
run started against snapshotted in `~/.wf/sources/`; durable engine state lives
in `~/.wf/engine.sqlite`; Executor's catalog lives in `~/.wf/executor.sqlite`;
and encrypted credentials live in `~/.wf/executor-auth.json` with their
user-only key in `~/.wf/executor-auth.key`.

Bun is the supported runtime. Source and documentation live at https://github.com/mokronos/wf.
