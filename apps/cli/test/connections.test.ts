import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import {
  addExecutorOpenApi,
  closeExecutor,
  createExecutorConnection,
  executeExecutorTool,
  listExecutorConnections,
  listExecutorIntegrations,
  listExecutorTools,
  setExecutorStorageDirectory
} from "@mokronos/wfkit"
import {
  authorizationUrlWithScopes,
  authorizeExecutorInBrowser
} from "../src/cli/oauth.ts"

const servers: Array<ReturnType<typeof Bun.serve>> = []
const directories: Array<string> = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const directory of directories.splice(0)) {
    await closeExecutor(directory)
    await rm(directory, { recursive: true, force: true })
  }
})

describe("Executor connections", () => {
  test("explicit OAuth scopes override discovered authorization scopes", () => {
    const authorizationUrl = authorizationUrlWithScopes(
      "https://provider.example/authorize?scope=read+write&state=test",
      ["read", "read"]
    )
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("read")
  })

  test("persists the catalog and keeps credentials outside workflow state", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-connections-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)
    const server = Bun.serve({
      port: 0,
      fetch(): Response {
        return Response.json({
          openapi: "3.1.0",
          info: { title: "Secured API", version: "1.0.0" },
          servers: [{ url: `http://127.0.0.1:${server.port}` }],
          paths: {},
          components: {
            securitySchemes: {
              bearer: { type: "http", scheme: "bearer" }
            }
          },
          security: [{ bearer: [] }]
        })
      }
    })
    servers.push(server)

    await addExecutorOpenApi({
      spec: `http://127.0.0.1:${server.port}/openapi.json`,
      slug: "secured"
    })
    await createExecutorConnection({
      integration: "secured",
      name: "work",
      template: "bearer",
      value: "super-secret-token"
    })
    expect(await listExecutorConnections()).toEqual([
      expect.objectContaining({
        integration: "secured",
        name: "work",
        template: "bearer"
      })
    ])

    await closeExecutor(directory)
    setExecutorStorageDirectory(directory)
    expect((await listExecutorIntegrations()).map((entry) => entry.slug)).toContain("secured")
    expect(await listExecutorConnections()).toEqual([
      expect.objectContaining({
        integration: "secured",
        name: "work"
      })
    ])

    const credentialPath = path.join(directory, "executor-auth.json")
    expect((await stat(credentialPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(credentialPath, "utf8")).not.toContain("super-secret-token")
    expect((await stat(path.join(directory, "executor-auth.key"))).mode & 0o777).toBe(0o600)
    const databaseFiles = (await readdir(directory)).filter((file) =>
      file.startsWith("executor.sqlite")
    )
    const databaseText = Buffer.concat(
      await Promise.all(databaseFiles.map((file) => readFile(path.join(directory, file))))
    ).toString("utf8")
    expect(databaseText).not.toContain("super-secret-token")
  })

  test("completes Executor OAuth with PKCE and invokes the connected tool", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wf-executor-oauth-"))
    directories.push(directory)
    setExecutorStorageDirectory(directory)
    let codeChallenge = ""
    let tokenExchanges = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url)
        const baseUrl = `http://127.0.0.1:${server.port}`
        if (url.pathname === "/openapi.json") {
          return Response.json({
            openapi: "3.1.0",
            info: { title: "OAuth Profile", version: "1.0.0" },
            servers: [{ url: baseUrl }],
            paths: {
              "/whoami": {
                get: {
                  operationId: "profile.whoami",
                  responses: {
                    "200": {
                      description: "Current profile",
                      content: {
                        "application/json": {
                          schema: {
                            type: "object",
                            required: ["name"],
                            properties: { name: { type: "string" } }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            components: {
              securitySchemes: {
                oauth: {
                  type: "oauth2",
                  flows: {
                    authorizationCode: {
                      authorizationUrl: `${baseUrl}/authorize`,
                      tokenUrl: `${baseUrl}/token`,
                      scopes: { profile: "Read the current profile" }
                    }
                  }
                }
              }
            },
            security: [{ oauth: ["profile"] }]
          })
        }
        if (url.pathname === "/authorize") {
          expect(url.searchParams.get("client_id")).toBe("wf-test-client")
          expect(url.searchParams.get("code_challenge_method")).toBe("S256")
          codeChallenge = url.searchParams.get("code_challenge") ?? ""
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "")
          callback.searchParams.set("code", "one-time-code")
          callback.searchParams.set("state", url.searchParams.get("state") ?? "")
          return new Response(null, {
            status: 302,
            headers: { location: callback.toString() }
          })
        }
        if (url.pathname === "/token") {
          const body = new URLSearchParams(await request.text())
          expect(body.get("grant_type")).toBe("authorization_code")
          expect(body.get("code")).toBe("one-time-code")
          expect(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"))
            .toBe(codeChallenge)
          tokenExchanges += 1
          return Response.json({
            access_token: "oauth-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "profile"
          })
        }
        if (url.pathname === "/whoami") {
          expect(request.headers.get("authorization")).toBe("Bearer oauth-access-token")
          return Response.json({ name: "Executor User" })
        }
        return new Response("not found", { status: 404 })
      }
    })
    servers.push(server)

    await addExecutorOpenApi({
      spec: `http://127.0.0.1:${server.port}/openapi.json`,
      slug: "oauth_profile"
    })
    const integration = (await listExecutorIntegrations()).find(
      (entry) => entry.slug === "oauth_profile"
    )
    const authMethod = integration?.authMethods.find((method) => method.kind === "oauth")
    if (authMethod === undefined) throw new Error("Executor did not derive OpenAPI OAuth")

    const connection = await authorizeExecutorInBrowser({
      integration: "oauth_profile",
      connection: "default",
      authMethod,
      clientId: "wf-test-client",
      scopes: ["profile"],
      open: async (authorizationUrl) => {
        const authorization = await fetch(authorizationUrl, { redirect: "manual" })
        const callback = authorization.headers.get("location")
        if (callback === null) throw new Error("OAuth fixture did not redirect")
        const response = await fetch(callback)
        expect(response.status).toBe(200)
      }
    })
    expect(connection.integration).toBe("oauth_profile")
    expect(connection.name).toBe("default")
    expect(tokenExchanges).toBe(1)

    const [tool] = await listExecutorTools({
      integration: "oauth_profile",
      connection: "default"
    })
    if (tool === undefined) throw new Error("Executor did not expose the OAuth tool")
    await expect(executeExecutorTool(tool.address, {})).resolves.toEqual({
      name: "Executor User"
    })
  })
})
