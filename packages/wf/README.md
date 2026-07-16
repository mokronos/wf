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

## CLI

```sh
bun add -g @mokronos/wfkit
```

This installs the `wf` binary:

```sh
wf create <workflow-id> [--name <workflow-name>] [--source <typescript>] [--file <path>] [--version <version>] [--force]
wf list
wf runs
wf history <execution-id>
wf run <workflow-id> [json-input]
wf signal <run-id> <signal-name> [json-payload] [--actor <actor>]
```

CLI state lives in `.wf/wf.sqlite`; durable engine state lives in `.wf/engine.sqlite`.

Bun is the supported runtime. Source and documentation live at https://github.com/mokronos/wf.
