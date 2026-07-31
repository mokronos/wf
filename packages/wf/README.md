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
  version: 1,
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
and invocation. The workflow stores only the address.

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
  version: 1,
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
wf integrations discover https://mcp.example.com/mcp --json
wf integrations connect <integration-slug> --connection default
wf integrations tools --integration <integration-slug> --connection default --json
wf integrations invoke <tool-address> '{"query":"status"}'
wf integrations connections
```

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

```sh
wf create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]
wf list
wf run <workflow-id> [json-input]
wf runs
wf history <execution-id>
wf signal <run-id> <signal-name> [json-payload] [--actor <actor>]
wf integrations --help
```

Use `wf help <command>` or `wf <command> --help` for command-specific options
and examples.

Global CLI state lives in `~/.wf/wf.sqlite`; durable engine state lives in
`~/.wf/engine.sqlite`; Executor's catalog lives in `~/.wf/executor.sqlite`; and
encrypted credentials live in `~/.wf/executor-auth.json` with their user-only
key in `~/.wf/executor-auth.key`.

Bun is the supported runtime. Source and documentation live at https://github.com/mokronos/wf.
