import { Effect, Encoding, FileSystem, Path } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import assets from "./embedded-web-assets.gen.ts"

const mimeTypeFor = (pathname: string): string => {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8"
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8"
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (pathname.endsWith(".svg")) return "image/svg+xml"
  if (pathname.endsWith(".png")) return "image/png"
  if (pathname.endsWith(".woff2")) return "font/woff2"
  return "application/octet-stream"
}

/** A compiled binary carries the dashboard inside it; running from source reads
 *  the Vite build output from the repository instead. */
export const dashboardIsEmbedded = Object.keys(assets).length > 0

const notFound = HttpServerResponse.text("Not found", { status: 404 })

const fileResponse = Effect.fnUntraced(function* (pathname: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(import.meta.dirname, "..", "..", "..", "apps", "wf", "web", "dist")
  const location = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1))
  // Traversal guard: a request may only name something under the build output.
  if (location !== root && !location.startsWith(`${root}${path.sep}`)) return notFound
  if (!(yield* fs.exists(location))) {
    return HttpServerResponse.text(
      `Dashboard assets not found at ${root}. Run: bun run --cwd apps/wf/web build`,
      { status: 404 }
    )
  }
  return yield* HttpServerResponse.file(location, {
    headers: { "content-type": mimeTypeFor(location) }
  })
})

export const dashboardResponse = Effect.fnUntraced(function* (pathname: string) {
  if (!dashboardIsEmbedded) return yield* fileResponse(pathname)
  const asset = assets[pathname === "/" ? "/index.html" : pathname]
  if (asset === undefined) return notFound
  const body = yield* Effect.fromResult(Encoding.decodeBase64(asset.base64))
  return HttpServerResponse.uint8Array(body, {
    headers: {
      "content-type": asset.contentType.length === 0 ? mimeTypeFor(pathname) : asset.contentType
    }
  })
})
