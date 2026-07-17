# Use wfkit with an agent

Use these instructions when a user asks you to set up or test `wf`. Work in the user's project directory, install the global CLI explicitly, and keep authored workflow files in the project.

## Communication contract

Before running a workflow, tell the user about every action they may need to take. This includes providing credentials, authorizing an account, approving a network request, or responding to a human-in-the-loop signal. Explain what is needed and why before the workflow reaches that point.

Never invent credentials, silently substitute a different service, or leave the user with a workflow that appears to hang. If `wf` prints a pending signal command, relay that command and the expected payload to the user verbatim.

The example below only reads a public file from GitHub. It does not need an account or token and does not change anything on GitHub. Before running it, tell the user that it will:

- send one outbound `GET` request to `raw.githubusercontent.com`;
- create per-user workflow state under `~/.wf/`;
- read a public repository without sending credentials.

If the environment blocks outbound network access, tell the user that network permission is required and wait for their direction.

## Install and verify the CLI

Tell the user that this installs a global command and a per-user background
service, then install and verify it:

```sh
npm install --global @mokronos/wf
wf --help
wf install
```

`pnpm add --global`, `bun add --global`, and `yarn global add` are also
supported. The installed CLI is a standalone platform binary; users do not run
it through Bun. If no supported global package manager is available, ask before
installing or changing the user's runtime setup.

## Create a real integration workflow

Create `workflows/github-file-preview.ts` with this source:

```ts
import { defineStep, defineWorkflow, t } from "@mokronos/wfkit"

const DownloadFailed = t.taggedStruct("DownloadFailed", {
  url: t.string,
  status: t.number
})

const fetchPublicGitHubFile = defineStep({
  name: "FetchPublicGitHubFile",
  input: t.struct({
    owner: t.string,
    repository: t.string,
    path: t.string
  }),
  output: t.struct({
    url: t.string,
    bytes: t.number,
    preview: t.string
  }),
  errors: DownloadFailed,
  retry: { attempts: 3, backoff: "exponential" },
  execute: async (input, step) => {
    const encodedPath = input.path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/HEAD/${encodedPath}`
    const response = await fetch(url, {
      headers: { "user-agent": "wfkit-agent-example" }
    })

    if (!response.ok) {
      return step.fail({
        _tag: "DownloadFailed",
        url,
        status: response.status
      })
    }

    const contents = await response.text()
    return {
      url,
      bytes: new TextEncoder().encode(contents).byteLength,
      preview: contents.slice(0, 240)
    }
  }
})

export const GitHubFilePreviewWorkflow = defineWorkflow({
  name: "GitHubFilePreviewWorkflow",
  version: 1,
  input: t.struct({
    owner: t.string,
    repository: t.string,
    path: t.string
  }),
  output: t.struct({
    url: t.string,
    bytes: t.number,
    preview: t.string
  }),
  errors: DownloadFailed,
  run: function* (input, ctx) {
    return yield* ctx.run(fetchPublicGitHubFile, input)
  }
})
```

Register and run it:

```sh
wf create github-file-preview --file workflows/github-file-preview.ts --version 1
wf list
wf run github-file-preview '{"owner":"Effect-TS","repository":"effect","path":"README.md"}'
wf runs
```

Report the returned URL, byte count, and preview to the user. The completed run and its event history are persisted in `~/.wf/`; use the run ID printed by `wf run` to inspect it:

```sh
wf history <run-id>
```

## Continue from here

When adapting this example to an authenticated API, do not place secret values in workflow inputs or source code. Tell the user which secret is required, arrange an approved secret source, and use wfkit secret references so durable history stores the reference rather than the value.

For human approval flows, explain the decision and payload to the user before starting. When the run suspends, copy the exact `wf signal ...` command printed by the CLI and wait for the user's response before sending it.
