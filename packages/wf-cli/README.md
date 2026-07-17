# @mokronos/wf

The globally installable `wf` command, durable background service, and local dashboard.

```sh
npm install --global @mokronos/wf
wf install
wf web
```

The npm package installs a standalone platform binary. Bun is not required on the user's machine.
Workflow state is stored in `~/.wf` by default; set `WF_HOME` to override it.

`wf install` currently registers a per-user service on Linux and macOS. Windows
service registration is not implemented yet.
