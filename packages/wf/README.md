> **[Install the wf agent skill →](https://github.com/mokronos/wf/tree/main/packages/wf/skills/wf)** with `npx skills add https://codeload.github.com/mokronos/wf/tar.gz/f2fc266fc58be4881b86df67da42f88c856f24ea --skill wf`. It teaches compatible agents to discover and connect integrations, author workflows, and repair imported workflows.

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

Subpath exports: `@mokronos/wfkit/authoring` (workflow-definition API),
`@mokronos/wfkit/integrations` (the dependency-light integration contract),
`@mokronos/wfkit/schemas` (shared Effect schemas), and
`@mokronos/wfkit/testing` (test helpers).

## Executor integrations

`integration(...)` is one durable node backed by a gateway grant. The gateway
owns MCP/OpenAPI protocol handling, connections, credentials, schema discovery,
authorization, and invocation. A workflow stores only an alias and a tool name;
the grant binds that requirement to a connection per deployment. Discovery and
connection management are provided by the `integrations` CLI; authored workflows
only need `@mokronos/wfkit`.

```ts
import { defineWorkflow, integration, t } from "@mokronos/wfkit"

const CreatedIssue = t.struct({ id: t.string, title: t.string })

const createIssue = integration({
  source: {
    kind: "gateway",
    alias: "issues",
    tool: "create_issue"
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
integrations search <service-or-capability>
integrations discover https://mcp.example.com/mcp
integrations connect <integration-slug>
integrations tools <integration-slug> --filter release
integrations schema <tool-name> --verbose
integrations execute --direct <tool-address> '{"query":"status"}'
integrations connections
```

The default connection is `default`. Integration commands return complete JSON;
pipe into `jq` to summarize. `tools` lists names and descriptions
grouped by integration, narrowed by `--filter`; `schema` returns one tool's
address and full input and output schemas, from a bare tool name, an
integration slug plus a tool name, or a tool address.

For API keys or bearer tokens, pass the name of an environment variable with
`--credential-env`; the value is never printed. OAuth uses Executor's discovery,
dynamic registration when supported, PKCE, token refresh, and a loopback
callback. Credentials are AES-GCM encrypted in `~/.wf/executor-auth.json` using
the user-only `~/.wf/executor-auth.key`; neither credentials, connection names,
nor resolved tool addresses are written to workflow source or durable history.

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
│   ├── search
│   ├── list
│   ├── connect
│   ├── connections
│   ├── tools
│   ├── schema
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
