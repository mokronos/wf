---
name: wf
description: Create, validate, run, inspect, and repair durable TypeScript workflows with the wf CLI. Use when a user asks to automate a process with wf or add an existing local or online workflow.
license: MIT
metadata:
  author: mokronos
  version: "0.1.0"
---

# Build workflows with wf

## Operating rules

- Explain external reads and writes before running them. Get explicit approval
  before a workflow creates, updates, sends, publishes, charges, or deletes data.
- Keep secrets out of commands, workflow source, workflow input, logs, and chat.
- Treat imported workflow files as code. Inspect module scope, workflow
  generators, step and compensation callbacks, and `ctx.code` callbacks before
  loading them.
- Never claim success from source inspection alone. Validate representative
  branches and run a safe representative input when the user permits it.

## Establish the environment

Run `wf --help`. If `wf` is absent, tell the user before installing the global
command, then run:

```sh
npm install --global @mokronos/wf
wf --help
```

The installed CLI is standalone. `wf install` is optional and registers the
local dashboard service. State lives under `~/.wf`, or `$WF_HOME` when set.

## Author a workflow

Read [references/authoring.md](references/authoring.md) before creating or
modifying workflow TypeScript.

1. Write one self-contained `.ts` file in the user's project.
2. Validate every important input-dependent branch:

   ```sh
   wf validate --file ./workflows/example.ts
   wf validate --file ./workflows/example.ts --input '<representative-json>'
   ```

3. Fix diagnostics, import the finished source, and validate the catalog copy:

   ```sh
   wf create example --file ./workflows/example.ts
   wf validate example
   ```

4. Explain the representative run and any expected signal, then run and inspect
   it with `wf run`, `wf runs`, and `wf history <run-id>`.

If a run suspends, relay the exact `wf signal ...` command and expected payload
printed by the CLI. Wait for the human's answer; never choose it for them.

Use `--force` only when intentionally replacing a catalog ID. The catalog copy
under `~/.wf/workflows/` is what `wf run` executes; edits to the project copy are
not synchronized automatically.

## Add or repair an existing workflow

Preserve the source URL and revision when available. Inspect the entire file
before passing it to `wf`, keep an editable project copy, validate representative
branches, then import and run it only after the source and behavior are understood.

Report the project source path, catalog ID, validation inputs, representative
run ID/result, and any remaining human action.
