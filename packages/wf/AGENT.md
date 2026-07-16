# Use wfkit with an agent

Use these instructions when a user asks you to set up or test `@mokronos/wfkit`. Work in the user's project directory and use a project-local installation so the setup is reproducible.

## Communication contract

Before running a workflow, tell the user about every action they may need to take. This includes providing credentials, authorizing an account, approving a network request, or responding to a human-in-the-loop signal. Explain what is needed and why before the workflow reaches that point.

Never invent credentials, silently substitute a different service, or leave the user with a workflow that appears to hang. If `wf` prints a pending signal command, relay that command and the expected payload to the user verbatim.

The example below only reads a public file from GitHub. It does not need an account or token and does not change anything on GitHub. Before running it, tell the user that it will:

- send one outbound `GET` request to `raw.githubusercontent.com`;
- create local workflow state under `.wf/`;
- read a public repository without sending credentials.

If the environment blocks outbound network access, tell the user that network permission is required and wait for their direction.

## Install and verify the CLI

Check that Bun 1.2 or newer is available, then install wfkit locally:

```sh
bun --version
bun add --dev @mokronos/wfkit
bunx wf --help
```

If Bun is unavailable, tell the user that wfkit currently requires Bun and ask before installing or changing their runtime setup.

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
bunx wf create github-file-preview --file workflows/github-file-preview.ts --version 1
bunx wf list
bunx wf run github-file-preview '{"owner":"Effect-TS","repository":"effect","path":"README.md"}'
bunx wf runs
```

Report the returned URL, byte count, and preview to the user. The completed run and its event history are persisted in `.wf/`; use the run ID printed by `wf run` to inspect it:

```sh
bunx wf history <run-id>
```

## Continue from here

When adapting this example to an authenticated API, do not place secret values in workflow inputs or source code. Tell the user which secret is required, arrange an approved secret source, and use wfkit secret references so durable history stores the reference rather than the value.

For human approval flows, explain the decision and payload to the user before starting. When the run suspends, copy the exact `wf signal ...` command printed by the CLI and wait for the user's response before sending it.
