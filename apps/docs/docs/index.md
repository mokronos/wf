# wf documentation

`wf` is an agent-first workflow platform. An agent designs a workflow; a small,
durable runtime executes the resulting TypeScript artifact.

Execution is durable: step results, timers, and signal waits are persisted in
SQLite, so runs replay deterministically and survive process restarts.

## Surfaces

| Surface | Package | Purpose |
| --- | --- | --- |
| `wf` CLI | `@mokronos/wf` | Create, validate, run, signal, and inspect workflows; serve the local dashboard |
| TypeScript SDK | `@mokronos/wfkit` | Authoring API, embeddable runtime, and test helpers |

## First Run

```bash
bun install -g @mokronos/wf
wf create hello
wf validate hello
wf run hello '{"message":"hello from wf"}'
```

State lives under `~/.wf` by default. Set `WF_HOME` to use another directory.

## Next

- [**wf CLI**](cli.md) documents commands and output.
- [**TypeScript SDK**](wfkit.md) documents authoring, runtime, and testing APIs.
