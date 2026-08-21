---
name: integrations
description: Use the `i` (integrations) CLI to find, connect, and call external APIs and MCP servers through the local gateway. Use when you need a tool from an outside service (Linear, GitHub, Gmail, Slack, any OpenAPI/MCP endpoint) and don't already have a working call for it.
---

# integrations (`i`)

`i` is a thin client over a local **gateway** that holds every connection and
credential. Nothing else sees a credential. `i` and `integrations` are the same
command.

Commands print complete JSON — every row, every field; `-v` pretty-prints.
Narrow with `--filter` on `tools`, `--limit`/`--offset` on any listing, or a
pipe into `jq`.

## Quickstart

```bash
i serve -d                                   # once — start the gateway if it isn't running

i search linear                              # 1. find the integration's discovery URL
i discover https://mcp.linear.app/mcp        # 2. register it; returns slug, tools, auth templates
i connect mcp_linear_app                     # 3. authorize (OAuth opens a browser)

i tools mcp_linear_app --filter issue        # browse tool names
i schema mcp_linear_app list_issues          # read one tool's input/output schema

i grant <client-id> linear list_issues \
  --integration mcp_linear_app               # 4a. bind an alias for a client (`i clients` for ids)
i execute linear list_issues '{"limit":5}'   # 4b. call it as a delegated caller
```

`i execute --direct <tool-address> '<json>'` runs with your own authority — use
it to prove a fresh connection works, not for real calls.

Every call answers in one shape: `{"status":"succeeded","result":…}`,
`{"status":"pending","approvalId":…}`, `{"status":"denied","reason":…}`, or
`{"status":"failed","message":…}`. `pending` means a human has to decide: poll
`i approval <id>`, or just run the same call again — a retry meets the same
frozen call rather than asking again, and collects the decision once it lands.

## Rules

- Start from `search`/`discover`, never guess a URL, tool name, or schema.
- Read `schema` for the one tool you settled on before calling it — don't dump
  every schema.
- Never put a secret on the command line: `--credential-env NAME` names the env
  var holding it.
- Credentials live only in the gateway (`~/.wf/`). Don't copy them anywhere.

## Everything else

Connections, delegation, approvals, audit, drift, codegen — check help, it is
complete and current:

```bash
i --help
i <subcommand> --help
```
