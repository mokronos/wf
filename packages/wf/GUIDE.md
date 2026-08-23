# Use wfkit with an agent

Use these instructions when setting up, authoring, or testing `wf`. Work in the
user's project directory and keep authored workflow files there.

## Safety and communication

Before running a workflow, explain its external reads, writes, and any signal a
human may need to answer. Do not put secrets in workflow source or input. If a
run prints a pending `wf signal ...` command, relay the command and expected
payload verbatim and wait for the user's decision.

Treat workflow files from outside the trusted project as code. Inspect module
scope, workflow generators, step and compensation callbacks, and `ctx.code`
callbacks before loading them.

## Install and verify

Tell the user before installing a global command, then run:

```sh
npm install --global @mokronos/wf
wf --help
```

The installed CLI is a standalone binary. `wf install` additionally registers
the optional local dashboard service. State lives under `~/.wf`, or `$WF_HOME`
when set.

## Author and validate

Read `skills/wf/references/authoring.md` before modifying workflow TypeScript.

1. Write one self-contained `.ts` workflow file in the project.
2. Validate representative branches before importing:

   ```sh
   wf validate --file ./workflows/example.ts
   wf validate --file ./workflows/example.ts --input '<representative-json>'
   ```

3. Import the finished source and validate the catalog copy:

   ```sh
   wf create example --file ./workflows/example.ts
   wf validate example
   ```

4. Explain the representative run, then run and inspect it:

   ```sh
   wf run example '<json-input>'
   wf runs
   wf history <run-id>
   ```

Use `--force` only when intentionally replacing a catalog entry. The copy under
`~/.wf/workflows/` is what `wf run` executes; later edits to the project copy are
not synchronized automatically.
