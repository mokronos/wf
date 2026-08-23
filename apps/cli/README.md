# @mokronos/wf

The globally installable `wf` command, durable background service, and local
dashboard.

```sh
bun install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on
the user's machine. Workflow state is stored in `~/.wf` by default; set
`WF_HOME` to override it.

```text
wf
├── create
├── validate
├── list
├── run
├── runs
├── history (alias: events)
├── signal
├── install
├── web
└── daemon
```

Use `wf --help` or `wf <command> --help` for arguments, flags, examples, and
nested subcommands. Add `--verbose` (`-v`) for complete human-readable details;
machine-readable modes such as `wf validate --json` remain lossless.

`wf install` registers a per-user service on Linux and macOS. Windows service
registration is not implemented yet.
