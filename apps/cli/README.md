# @mokronos/wf

The globally installable `wf` command, durable background service, and local dashboard.

```sh
bun install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on the user's machine.
Workflow state is stored in `~/.wf` by default; set `WF_HOME` to override it.

Command tree:

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
│   ├── disconnect
│   ├── invoke
│   └── validate
├── install
├── web
└── daemon
```

Use `wf --help` or `wf <command> --help` for arguments, flags, examples, and
nested subcommands.

CLI output is progressive by default: collection commands show at most 10 workflow
records or 5 integration records, validation and execution print summaries, and
large results are previewed. Add `--verbose` (`-v`) to a command for complete
details. Explicit machine-detail modes such as `wf validate --json` remain lossless.

Integration discovery and execution use Executor for both MCP and OpenAPI:

```sh
wf i discover https://mcp.example.com/mcp
wf i search linear
wf i connect <integration-slug>
wf i tools <integration-slug> --search release
wf i schema <tool-name>
wf i invoke <tool-address> '{"query":"status"}'
```

The default connection is named `default`. Integration commands return compact
JSON by default; use `--text` for human-readable output and `--verbose` for full
objects. `discover` performs URL
detection, auth discovery, registration, and tool discovery. For OAuth, `connect`
opens a browser and returns through a loopback callback.
Inspection is progressive: `tools` lists names and descriptions grouped by
integration (narrow it with `--search`), and `schema` summarizes one named tool's
address and input and output schemas. Add `--verbose` for the complete schemas.
`schema` takes a bare tool name while
it is unique, an integration slug plus a tool name, or a tool address.
Credentials are AES-GCM encrypted with a separate user-only key; workflows
persist only the Executor tool address.

`search` queries the public integrations.sh catalog and returns the preferred
discovery URL for each result. Use `--verbose` for every MCP, API, and GraphQL
surface URL, or `--text` for a human-readable result.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
