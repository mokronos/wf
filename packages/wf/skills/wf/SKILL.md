---
name: wf
description: Discover and connect MCP or OpenAPI integrations, create and validate durable TypeScript workflows with the wf CLI, and install or repair shared workflows. Use when a user asks to automate a process, build or run a wf workflow, connect an integration, inspect available integration tools, or add an existing local or online workflow.
license: MIT
compatibility: Requires the wf CLI, file editing, and network access for remote integrations. Authentication and approval may require a human.
metadata:
  author: mokronos
  version: "0.1.0"
---

# Build workflows with wf

Use `wf` as the source of truth for integration names, authentication methods,
tool addresses, and schemas. Do not guess any of them. Work autonomously until
`wf` identifies an action that only a human can complete.

## Operating rules

- Explain external reads and writes before invoking them. Get explicit approval
  before a workflow will create, update, send, publish, charge, or delete data.
- Keep credentials out of commands, workflow source, workflow input, logs, and
  chat. Use `wf i connect` and environment-variable options.
- Prefer OAuth over asking for a token. Before OAuth, tell the human which
  service/account, requested scopes, and purpose; request only needed scopes.
- Ask the human only for native-human steps: choosing an account, browser
  authorization, supplying a secret through an environment variable, approving
  consequential behavior, or deciding an ambiguous integration/tool match.
- Never claim success from source inspection alone. Validate the workflow and
  every referenced integration, then run a safe representative input when the
  user permits it.
- Treat workflow files from outside the current trusted project as code:
  inspect them before loading. `wf create` and `wf validate` evaluate module
  scope; validation also executes `ctx.code` callbacks.

## Establish the environment

First run:

```sh
wf --help
wf i --help
```

If `wf` is absent, tell the user that the following installs a global command,
then run:

```sh
npm install --global @mokronos/wf
wf --help
```

Use the installed standalone CLI directly, not `bun wf`. `wf install` is
optional and installs the local dashboard service; it is not required to author
or run workflows. State is under `~/.wf`, or `$WF_HOME` when set.

Run `wf` commands that share one `WF_HOME` sequentially. Separate CLI processes
can contend for the same Executor SQLite database if an agent launches catalog,
connection, schema, or history reads in parallel.

## Discover and connect integrations

Follow this funnel. Use JSON output when extracting fields and `--text` when a
human will read it.

1. Check what is already known and connected:

   ```sh
   wf i list
   wf i connections
   wf i tools --search '<capability>'
   ```

2. If no connected tool fits, search the public catalog by service or
   capability. Search is read-only and returns candidate discovery URLs:

   ```sh
   wf i search '<service-or-capability>' --text
   ```

3. Select an exact MCP endpoint or OpenAPI document URL from the result or the
   service's official docs, then let Executor detect and register it:

   ```sh
   wf i discover '<mcp-endpoint-or-openapi-url>' --text
   ```

   `discover` mutates the local catalog. A no-auth integration is connected
   automatically and reports tools. Do not run `wf i connect` for a no-auth
   integration.

4. If discovery says authentication is required, stop for the human handoff.
   Explain the account, permissions, and next action, then use the method
   reported by discovery:

   ```sh
   # OAuth; add --scopes only after selecting the minimum required set.
   wf i connect <integration-slug> --text

   # API key, bearer, or header; the human sets the value outside chat first.
   wf i connect <integration-slug> --credential-env SERVICE_TOKEN --text
   ```

   Use `--no-open` when a browser cannot be launched and relay the printed URL.
   Never invent a credential or silently switch services when authorization is
   unavailable.

5. Browse compact tool names, then retrieve the exact schema for only the tools
   likely to be used:

   ```sh
   wf i tools <integration-slug> --text
   wf i tools <integration-slug> --search '<operation>' --text
   wf i schema <integration-slug> <tool-name>
   ```

   `wf i schema` returns the canonical `tools.<...>` address and complete input and
   output schemas. A bare tool name works only when unique.

6. Before authoring, live-validate each selected address. For a read-only tool,
   also use a minimal safe invocation when useful:

   ```sh
   wf i validate '<tool-address>' --text
   wf i invoke '<tool-address>' '<minimal-json-input>'
   ```

   Direct address validation is live. Do not invoke a write tool merely as a
   test.

## Author a workflow

Read [references/authoring.md](references/authoring.md) before writing or
modifying workflow TypeScript.

Use this loop:

1. Write one self-contained `.ts` file in the user's project. Mirror selected
   tool schemas with `t`, and persist only canonical Executor addresses.
2. Validate before importing. Use representative inputs for every important
   branch because one validation traces only one path:

   ```sh
   wf validate --file ./workflows/example.ts
   wf validate --file ./workflows/example.ts --input '<representative-json>'
   ```

3. Fix diagnostics and repeat until all relevant traces pass.
4. Import it into the catalog with a lowercase ID:

   ```sh
   wf create example --file ./workflows/example.ts
   wf validate example
   ```

   Use `--force` only when intentionally replacing that catalog ID. The catalog
   copy under `~/.wf/workflows/` is what `wf run` executes; later edits to the
   project copy are not synchronized automatically.
5. Confirm the `integrations:` section from `wf validate` reports every address
   as `ready`. Workflow validation traces integration steps with fake outputs
   and live-checks the addresses it reached without invoking them. Also keep the
   explicit `wf i validate` checks above when documenting each selected tool.
6. Tell the human exactly what the representative run will read/write and any
   signal it may request. With approval, run and inspect it:

   ```sh
   wf run example '<json-input>'
   wf runs
   wf history <run-id>
   ```

If a run suspends, it exits successfully and prints `wf signal <...>` on stderr.
Explain the decision and expected payload, wait for the human's answer, then run
the exact command with their chosen payload. Never choose an approval for them.

## Add or repair an existing workflow

Use this procedure for a project file, shared file, repository, or online
workflow:

1. Acquire it with the agent's normal file/web tools. Preserve provenance (URL
   and revision when available). Do not execute a remote shell installer.
2. Inspect the complete source before passing it to `wf`. Reject or ask about
   unexpected module-scope IO, credential reads, non-`@mokronos/wfkit` imports,
   or external side effects in `run`/`ctx.code`.
3. Keep an editable project copy. Validate it outside the catalog first:

   ```sh
   wf validate --file ./workflows/shared.ts
   ```

4. Run representative traces and use the resulting `integrations:` section as
   the missing-connection worklist. Because validation follows one branch at a
   time, also inventory every literal address matching
   `tools.<integration>.<org|user>.<connection>.<tool>` in the complete source.
   For each address, run:

   ```sh
   wf i validate '<tool-address>' --text
   ```

5. Repair each missing address in order:

   - Parse the integration slug, connection name, and tool name from the
     address. Check `wf i list`, `wf i connections`, and
     `wf i tools <slug> --connection <connection> --text`.
   - If the integration is absent, run `wf i search '<slug>' --text`. Discover
     only an exact, trusted endpoint. If no exact match exists, use the
     workflow's documentation or ask the human; do not substitute a similar
     service.
   - Preserve the workflow's connection name with
     `wf i discover <url> --connection <connection>` for no-auth integrations,
     or `wf i connect <slug> --connection <connection>` for authenticated ones.
   - Complete any human authentication handoff, inspect the exact tool schema,
     and compare it to the authored `input` and `output`. If the provider's
     canonical address changed, update the workflow source rather than trying
     to fabricate the old address.
   - Repeat live validation until the address passes.

6. Validate representative workflow branches again, import, validate the
   catalog copy, and run only after all addresses pass:

   ```sh
   wf create <lowercase-id> --file ./workflows/shared.ts
   wf validate <lowercase-id>
   ```

`wf validate` reports all integration requirements reached by that trace in one
pass and exits nonzero while any are missing. The source inventory remains
necessary for integration steps hidden behind branches not exercised by the
chosen input.

## Completion report

Report:

- project source path and catalog ID;
- integrations and connection names used, without credentials;
- workflow validation inputs tested and whether each passed;
- live validation status of every tool address;
- whether a representative run occurred, its run ID/result, or why it was not
  safe/possible;
- any remaining human action, copied as an exact command when appropriate.
