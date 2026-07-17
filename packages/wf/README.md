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

## Generic integrations

`integration(...)` is one durable node for MCP tools and HTTP/OpenAPI operations.
Authentication is configured separately with `auth(...)`; only the reference is
part of the workflow definition, while the credential is resolved immediately
before execution.

```ts
import { auth, defineWorkflow, integration, t } from "@mokronos/wfkit"

const CreatedIssue = t.struct({ id: t.string, title: t.string })

const createIssue = integration({
  source: { kind: "mcp", url: "https://mcp.example.com/mcp" },
  operation: "create_issue",
  auth: { kind: "bearer", credential: auth("linear-oauth") },
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

The CLI maps `auth("linear-oauth")` to `LINEAR_OAUTH`. Custom runtimes can
provide any `SecretResolver`, including a vault-backed OAuth connection manager.
API-key, bearer-token, and custom-header authentication are supported.

## CLI

The CLI is distributed separately as `@mokronos/wf` and installs a global,
standalone `wf` command:

```sh
npm install --global @mokronos/wf
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
```

Use `wf help <command>` or `wf <command> --help` for command-specific options
and examples.

Global CLI state lives in `~/.wf/wf.sqlite`; durable engine state lives in
`~/.wf/engine.sqlite`.

Bun is the supported runtime. Source and documentation live at https://github.com/mokronos/wf.
