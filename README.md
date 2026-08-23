# wf

`wf` is an agent-first platform for authoring and running durable TypeScript
workflows. Agents design readable workflow artifacts; the runtime persists step
results, timers, and signal waits in SQLite so runs can survive restarts and
replay deterministically.

## Install

```bash
bun install -g @mokronos/wf
wf create hello
wf validate hello
wf run hello '{"message":"hello from wf"}'
```

State defaults to `~/.wf`; set `WF_HOME` to use another directory.

## Core ideas

- **Structured orchestration:** typed steps, retries, timers, signals, parallel
  work, and compensations are durable runtime primitives.
- **Code for computation:** deterministic transforms stay as TypeScript code;
  external IO belongs in durable steps.

## Integration nodes

`wfkit` retains a declarative integration node for portable workflow
definitions. Executing those nodes requires the separate
[`mokronos/integrations`](https://github.com/mokronos/integrations) gateway and
runner; this repository does not include integration discovery, credentials,
policy, client wiring, or execution.

## Repository Map

| Path | Purpose |
| --- | --- |
| `packages/wf/` | `@mokronos/wfkit` SDK and agent authoring guidance |
| `apps/cli/` | `@mokronos/wf` CLI and workflow dashboard service |
| `apps/wf/web/` | Workflow dashboard |
| `apps/marketing/` | Product site |
| `apps/docs/` | Workflow documentation |
| `examples/` | Runnable workflow examples |

## Development

```bash
bun run typecheck
bun test
bun run build
```
