# Integrations CLI

`integrations` is a thin client over the **gateway**: the local service that
holds every connection and credential, resolves grants, decides authorization
policy, and performs invocations. Nothing else ever sees a credential. It also
installs as `i`, so `i tools linear` and `integrations tools linear` are the
same command.

```bash
integrations --help
```

The command needs Bun on the machine. It ships in
`@mokronos/integrations-cli`, a dependency of `@mokronos/wf` — not yet published
to npm, so install it from the repository with `bun run install:local`, which
puts `wf`, `integrations`, and `i` on your `PATH`.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Integration** | An external system in the catalog — Gmail, Slack, a GitHub API. Discovered from a standardised description, never hand-authored |
| **Tool** | One named operation an integration exposes, with its own input and output schemas. The smallest unit that can be invoked, granted, or approved |
| **Connection** | A stored authorization letting you use an integration. Holds references exchanged for credentials at the moment of use |
| **Connection name** | The label distinguishing several connections to one integration — three Google accounts as `personal`, `work`, `client-x`. Defaults to `default` |
| **Owner tier** | Which partition a connection is filed under: `org` (shared by the tenant) or `user` (private to one subject) |
| **Client** | Anything that calls the gateway — an agent, a workflow runner, a script. Has no inherent access |
| **API key** | The credential a client presents. Identifies the client and nothing else |
| **Grant** | A delegation: one client may invoke one tool through one connection. The only source of a client's access |
| **Alias** | The logical name a grant exposes a tool under. A caller declares it as a requirement; each deployment binds it — an environment variable, not a pointer |
| **Pending approval** | An invocation frozen awaiting a human decision. Approving discharges that one invocation and confers no capability |
| **Drift** | A divergence between the catalog's recorded shape of a tool and what the vendor now exposes |

## Starting the gateway

Every command goes through the gateway; there is no local fallback.

```bash
integrations serve
```

| Flag | Meaning |
| --- | --- |
| `--port <integer>` | Port to listen on. Defaults to 4788 (the workflow dashboard already owns 4787) |
| `--host <string>` | Bind address. Defaults to `127.0.0.1` |
| `--detach`, `-d` | Start in the background and return once the gateway answers |

On start it ensures a local privileged client exists, mints a key for it, and
writes `~/.wf/gateway.json` (mode `0600`) with the URL and that key — so the
local case is zero-configuration. Clients read it automatically; set
`INTEGRATIONS_URL` and `INTEGRATIONS_API_KEY` to point somewhere else instead.

> Binding outside loopback exposes a credential that unlocks every connection
> the client holds. Terminate TLS in front of it and treat it as a deliberate
> act.

If nothing is running you get: *No gateway found. Start one with `integrations
serve`, or set INTEGRATIONS_URL and INTEGRATIONS_API_KEY.*

### Keeping it running

Three lifetimes, in order of how long they last:

```bash
integrations serve       # this terminal
integrations serve -d    # background, until logout
integrations install     # a per-user service, across reboots
```

`-d` is what `&` would do, without needing to know that: it spawns the gateway,
waits until it answers an authenticated request, then prints the pid and the log
path and exits. Output goes to `~/.wf/logs/integrations.log` and
`integrations.error.log`. Stop it with `kill <pid>`. It does not survive logout
or a reboot.

### Hosting it

The same gateway can run as a multi-tenant hosted service: humans sign in to
the dashboard with email and password (the first signup claims the instance),
clients keep using API keys, OAuth callbacks arrive at the gateway's public URL
instead of a loopback port, and gateway-held payloads are sealed at rest under
a master key. Point clients at it with `INTEGRATIONS_URL` and
`INTEGRATIONS_API_KEY`; nothing else about the client surface changes.

See [Hosting the gateway](../../../docs/deploy/gateway-cloud.md) for the
environment variables (`INTEGRATIONS_PUBLIC_URL`, `INTEGRATIONS_ALLOW_SIGNUP`,
`INTEGRATIONS_MASTER_KEY`, `INTEGRATIONS_RATE_LIMIT`,
`INTEGRATIONS_MAX_BODY_BYTES`), TLS setup, deployment targets, and operational
notes.

## integrations dashboard

The gateway serves a browser control plane on the same port it listens on. This
command finds a running gateway and opens it.

```bash
integrations dashboard
integrations dashboard --print   # print the URL, open nothing
```

It will not start a gateway for you: a UI that silently launches the process
holding every credential is not a convenience. If nothing is running you get
told to run `integrations serve`.

### What it covers

| View | What you can do |
| --- | --- |
| Integrations | Discover an endpoint, connect and disconnect, browse every tool with its input and output schema |
| Clients | Create a client, issue and revoke keys, revoke the client |
| Clients → grants | Grant one tool through one connection under an alias, switch a grant between *allow* and *ask a human*, revoke it |
| Approvals | See frozen calls with their exact arguments, approve (the gateway performs the call) or deny |
| Executions | The audit trail: every attempt, its outcome, and which grant decided it |
| System | Refresh a catalog snapshot and read the drift report; run maintenance now |

### How it authenticates

It does not carry an API key, and there is nowhere to put one. The page is
served by the gateway itself, so a request from it is same-origin, arrives over
loopback, and is authenticated as the local client — the key stays in
`~/.wf/gateway.json`, mode `0600`, and never reaches the browser.

Four things must all hold, or the request gets the same 401 as any stranger:

- the gateway is bound to loopback (`--host` anything else turns this off
  entirely, because a proxy on the same box would make every forwarded request
  look local)
- the request arrived from a loopback address
- `Host` names a loopback host, which is what stops DNS rebinding
- `Sec-Fetch-Site` is `same-origin`, and any `Origin` present is the gateway's
  own — which is what stops a page on another site reaching for `127.0.0.1:4788`

A caller that presents a key of its own is that client, with that client's
limits; the ambient credential never upgrades anyone. Callers that are not
browsers — curl, the CLI, any API client — send no `Sec-Fetch-Site` and go on
authenticating exactly as before.

> This is a boundary against other *sites*, not against other *processes* on
> your machine. Anything that can open a socket to loopback can send these
> headers too. Binding the gateway to loopback already trusts local processes;
> this does not widen that, but it does not narrow it either.

## integrations install

Register and start the gateway as a per-user service.

```text
integrations install [--port <integer>] [--verbose]
```

`systemd --user` on Linux, `launchd` on macOS, under the label
`dev.mokronos.integrations` — its own unit rather than the dashboard's
`dev.mokronos.wf`, because the gateway holds the credentials the dashboard reads
and has to be able to outlive it. Windows service registration is not
implemented yet.

The service always binds loopback: a service that starts at login and exposes a
credential-unlocking port to the network should be a deliberate `integrations
serve --host` in a terminal. On Linux it also asks for `enable-linger`, so the
gateway is up on a machine reached over SSH; that is best effort and needs
polkit.

Installing is idempotent, and rerunning it is also how you restart the service
onto upgraded sources — the background service keeps running the code it started
with. The command returns only once the gateway answers, not once the service
manager accepts the unit.

## integrations upgrade

Upgrade this CLI to the latest published version.

```text
integrations upgrade [--check] [--pull]
```

| Flag | Meaning |
| --- | --- |
| `--check` | Report the version that is available and change nothing |
| `--pull` | For a source install: fast-forward the checkout the CLI runs from |

It works out how this copy was installed and then uses whatever installed it: a
global install is replaced through its own package manager (`bun`, `npm`, `pnpm`,
or `yarn`, read off the tree it lives in), and the version to install comes from
the registry rather than a hardcoded number. An unpublished package is reported
as unpublished instead of failing obscurely.

A **source install** — the shims `bun run install:local` writes — has no package
to replace, because it runs the working tree directly. `--pull` fast-forwards
that checkout instead, and runs `bun install` if the pull moved the lockfile. It
refuses a dirty tree or a non-fast-forward: the job is to update a CLI, not to
resolve a merge.

Upgrading never restarts anything. The installed service keeps serving the
version it started with — the command says so, and `integrations install`
restarts it when you are ready.

## integrations uninstall

```text
integrations uninstall [--verbose]
```

Stops and deregisters the service. `~/.wf` is left alone: it holds the
connections and credentials, and removing a service definition is not consent to
delete those.

## Output conventions

Integration commands return complete JSON — the reader is usually an agent, and
a summary that drops fields is the failure mode this CLI exists to prevent.

**Listings return every row.** Nothing is dropped behind a flag you did not know
to pass, because a truncated answer that looks complete is worse than a large
one: the reader acts on it. Rows come back in summary form and in a stable
order, with a `count` field saying how many there were.

Two flags, two separate questions:

| Flag | Question it answers |
| --- | --- |
| `--limit <n>`, `--offset <n>` | *How many rows?* A window over an ordered listing. Present on every listing |
| `--verbose`, `-v` | *How much of each row?* Complete objects, pretty-printed. Never changes how many rows |

When a listing is large it adds a `hint` naming the narrowing flag that fits it
(`--filter` for tools, `--status` for approvals) — but it still returns
everything. Piping into `jq` is the other half of that answer:

```bash
i tools mcp_linear_app | jq '.tools[] | select(.name | startswith("list"))'
i tools mcp_linear_app --limit 10 --offset 20      # or take a window
```

Only `audit` is bounded by default (50), because the trail is permanent and
grows without bound. It says so with `count`, and takes filters.

**JSON output always parses.** A long *value* may be shortened and marked; the
document is never cut. That includes tool results from `execute`.

A refusal that is about what your key *may do* reads *this key may not change
the catalog, connections, grants, or policy (use a key whose client may
mutate)* — the fix is a different key, not a different request. A refusal about
what you *asked for* states its own reason, and is never dressed up as the
former.

## Discovery and connections

Start from a URL rather than guessing protocol, auth, operation names, or
schemas.

### search

```text
integrations search [flags] <query>
```

| Flag | Meaning |
| --- | --- |
| `--kind <mcp\|openapi\|graphql\|cli>` | Limit results to one integration kind |
| `--limit <integer>` | How many results to ask the registry for. Default 5 |
| `--verbose` | Pretty-print the JSON |

Queries the public integrations.sh catalog and returns the preferred discovery
URL for each result. Its `--limit` is a request to the registry rather than a
window over a local listing, and results stay in the registry's relevance
order — so this is the one listing that is not re-sorted here.

### discover

```text
integrations discover [flags] <url>
```

| Flag | Meaning |
| --- | --- |
| `--connection <name>` | Connection name. Default `default` |
| `--verbose` | Pretty-print the JSON |

Runs the whole chain: URL → protocol detection (MCP or OpenAPI) → integration
registration → auth discovery → connection when the service is public → tool
names and input/output schemas. If auth is required, the result includes the
available auth templates and the integration slug to connect.

### connect

```text
integrations connect [flags] <integration>
```

| Flag | Meaning |
| --- | --- |
| `--connection <name>` | Connection name. Default `default` |
| `--template <name>` | Which discovered auth method to use |
| `--credential-env <NAME>` | Environment variable holding an API key or bearer token |
| `--credential-values <var=ENV,...>` | Comma-separated mappings for multi-value auth methods |
| `--client-id`, `--client-secret-env` | Pre-registered OAuth client, when dynamic registration is unavailable |
| `--no-open` | Print the authorization URL instead of launching a browser |
| `--timeout <integer>` | How long to wait for the OAuth callback |

OAuth discovers authorization metadata, registers a client dynamically when
supported, and runs authorization code + PKCE against a loopback callback.
Never put a secret value on the command line — name the environment variable
holding it. Credentials are AES-GCM encrypted in `~/.wf/executor-auth.json`
under the user-only key `~/.wf/executor-auth.key`.

If an integration offers both OAuth and a key, naming a credential without
`--template` is an error rather than a silent browser launch: opening a browser
while ignoring the key you named is the one outcome nobody asked for.

Connection names are normalised on the way in — `--connection docs-demo` is
stored as `docsDemo`. `connect` says so when it happens, and `disconnect`
accepts either spelling.

### connections, disconnect, integrations

```bash
integrations connections            # every connection, no credentials exposed
integrations integrations           # the persisted catalog. `list` still works
integrations disconnect <integration> [--connection <name>]
```

## Inspecting tools

Browse names first, then pull the schema for the one tool you settle on — a
hundred JSON Schemas is not a useful answer.

```text
integrations tools [flags] <integration>
integrations schema [flags] <integration> <tool>
```

| Flag | Meaning |
| --- | --- |
| `--filter <text>` | (`tools`) Keep only tools whose name or description contains this text |
| `--limit`, `--offset` | (`tools`) Window an ordered listing. Tools are ordered by name |
| `--connection <name>` | (`schema`) Which connection to read the schema through |
| `--verbose` | Pretty-print the JSON |

`schema` returns the tool's address, description, and complete input and output
schemas, as objects — mirror those in a workflow's `input` and `output`, and
author the node with the alias and tool name only. `--verbose` adds the
generated TypeScript renderings; it does not add the schemas, which are there
either way, whole. They are the reason to run the command.

Generic MCP envelopes are normalized before they reach callers: structured
content is returned directly, JSON text is parsed, and plain text stays a
string.

## Invoking

```text
integrations execute [flags] <alias> <tool> [<json>]              # delegated
integrations execute --direct [flags] <tool-address> [<json>]     # privileged
```

One verb, and a flag that says with whose authority. Without `--direct` the call
goes through an alias and can only reach what a grant exposes to the key — this
is what a delegated caller does. With `--direct` it names a resolved address and
runs with your own authority: how you prove a connection works right after
making it, not how production calls happen. A `tools.…` target is recognised as
an address either way. `invoke` still works as an alias for the direct form.
Both accept `--file` to read the JSON input from a file.

Every result is one shape, and it always parses:

```json
{"status":"succeeded","result":{…}}
{"status":"pending","approvalId":"…","expiresAt":"…"}
{"status":"denied","reason":"…"}
{"status":"failed","message":"…"}
```

`denied` and `failed` exit non-zero, but they print the outcome first: a refusal
is an answer, not a crash. Nothing is truncated — a JSON document cut mid-token
is not a smaller answer, it is an unusable one.

```text
integrations validate [flags] [<json-or-tool-address>]
```

Validates an integration node. Three input forms, one command:

| Input | Checked |
| --- | --- |
| `{"source":{"kind":"gateway","alias":"…","tool":"…"}}` | The shape a workflow authors: is the alias well formed, does this key hold a grant for it, is the tool still in the catalog |
| `tools.<slug>.<owner>.<connection>.<tool>` | A resolved address: is it well formed and still in the catalog |

Resolution is checked by default, for every form — `--structural` asks for the
shape check alone. A failed report exits 1.

## Delegation

A client is created, given a key, and granted specific tools. That is the only
source of its access.

```bash
integrations client "orders-agent" --may-mutate     # omit the flag for read-only access
integrations key <client-id>                        # shown once
integrations keys <client-id>                       # which keys exist, and when each was last used
integrations grant <client-id> <alias> <tool> --integration <slug>
integrations grants <client-id>
integrations grants --mine                          # what this key itself can reach
integrations clients
integrations revoke grant|client|key <id>
```

| `grant` flag | Meaning |
| --- | --- |
| `--integration <slug>` | The integration the alias resolves to |
| `--connection <name>` | Connection name. Default `default` |
| `--require-approval` | Freeze this tool's calls for a human instead of running them |

The alias is what a workflow declares. Binding it here is what lets one
definition run for different people against their own accounts, without editing
its source.

Undoing a delegation is `revoke`, and it is deliberately reversible-shaped:
revoked rows stay as history rather than disappearing. Revoking a **client**
also cancels its frozen calls, because a client is revoked when something is
wrong. Revoking a **key** does not — that is rotation, and in-flight work
should survive it.

Connections are filed under an org tier. A user tier exists in the domain and is
where this is going, but nothing can create a user-tier *connection* yet, so a
user-tier grant is refused rather than accepted into something that could only
fail when it ran.

## Approvals

```bash
integrations approvals [--status pending|approved|denied|expired]   # the queue, for a decider
integrations approval <approval-id>                                 # one call, for the caller that proposed it
integrations approve <approval-id> [--by <who>]
integrations deny <approval-id> [--by <who>]
```

A frozen invocation expires if nobody decides it, and expiry means the
invocation does not happen. On approval the gateway performs the call itself —
the caller never gains the capability.

**One frozen call, not one per attempt.** A retry of the same arguments through
the same grant meets the approval it already proposed, rather than asking a
human again; a step with `retry: { attempts: 3 }` produces one decision to make,
not three. Once decided, the next identical call collects the outcome — the
stored result, or the denial — exactly once. After that, an identical call is a
*new* request needing its own decision: one "yes" is one invocation, never
standing permission.

So a caller has two ways to wait, and both work: retry `execute` until it stops
saying `pending`, or poll `integrations approval <id>`. `approval` is on the
delegated tier, so the caller that proposed the frozen call can read it with its
own key.

## Audit and drift

```bash
integrations audit [--limit <n>] [--offset <n>] [--client <id>] [--alias <a>] [--tool <t>] [--outcome <o>] [--since <iso>]
integrations drift [<integration>]
```

The audit trail records every invocation attempt: client, alias, resolved
connection, subject acted for, tool, decision, outcome. It is retained
permanently; the arguments attached to it are not. Because it is permanent it is
the one listing read through a window — 50 records by default — and the one with
filters. `count` says how much matched.

`drift` re-reads a vendor's tools and reports what was added, removed, or
reshaped since the last sync — the cue to regenerate typed bindings. The first
refresh of an integration has nothing to compare against, so it records a
baseline and says so, instead of reporting the entire surface as newly added.

## Codegen

```text
integrations codegen [--target effect|ts] [--client <id>] [--out <file>]
```

| Target | Emits |
| --- | --- |
| `effect` | Effect Schema types plus ready-made `integration()` steps for `@mokronos/wfkit` |
| `ts` | TypeScript types plus typed calls over `@mokronos/integrations-client` |

The generated surface is exactly a grant surface: least privilege shows up in
autocomplete, and adding a tool means adding a grant. By default that is your
own key's grants; `--client <id>` generates the surface of the client you are
provisioning, which is usually the one you want and does not require holding its
key. See the [Gateway client](client.md) for what the output looks like.

## Maintenance

```bash
integrations maintenance
```

Runs the sweep the gateway already runs on a clock: expire frozen calls nobody
decided, and drop audit arguments past their retention. Both are decisions
rather than cleanups — an expired approval means the invocation does not happen.
You need this only to make either happen now.
