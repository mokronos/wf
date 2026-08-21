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
integrations discover https://mcp.example.com/mcp
integrations search linear
integrations connect <integration-slug>
integrations tools <integration-slug> --filter release
integrations schema <tool-name>
integrations execute --direct <tool-address> '{"query":"status"}'
```

The default connection is named `default`. Integration commands return complete
JSON; use `--verbose` for full, pretty-printed objects. `discover` performs URL
detection, auth discovery, registration, and tool discovery. For OAuth, `connect`
opens a browser and returns through a loopback callback.
Multi-value API-key methods use comma-separated
`--credential-values variable=ENV_NAME,...` mappings.
`tools` lists every tool's name and description (narrow it with `--filter`, or
window it with `--limit`/`--offset`), and `schema` returns one named tool's
address and its complete input and output schemas.
`schema` takes a bare tool name while
it is unique, an integration slug plus a tool name, or a tool address.
Credentials are AES-GCM encrypted with a separate user-only key. Workflows
persist only a gateway alias and tool name; grants resolve that requirement to a
connection on the machine that runs it. Resolved addresses and connection names
never enter workflow source.

`search` queries the public integrations.sh catalog and returns the preferred
discovery URL for each result. Use `--verbose` for every MCP, API, and GraphQL
surface URL.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
