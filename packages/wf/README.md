> **[Install the wf agent skill →](https://github.com/mokronos/wf/tree/main/packages/wf/skills/wf)** with `npx skills add https://codeload.github.com/mokronos/wf/tar.gz/f2fc266fc58be4881b86df67da42f88c856f24ea --skill wf`.

# @mokronos/wfkit

`@mokronos/wfkit` is a Bun-first SDK for authoring and running durable
workflows in plain TypeScript. Workflows have typed inputs, outputs, and errors;
the engine persists step results, timers, and signal waits in SQLite so runs can
survive restarts and replay deterministically.

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
    yield* ctx.run(printMessage, { message: input.message.trim() })
  }
})

run(HelloWorkflow, { message: "hello from @mokronos/wfkit" })
```

Subpath exports include `@mokronos/wfkit/authoring`,
`@mokronos/wfkit/schemas`, and `@mokronos/wfkit/testing`.

The separately distributed `@mokronos/wf` package provides the `wf` CLI and
local dashboard. Bun is the supported SDK runtime. Source and documentation
live at https://github.com/mokronos/wf.
