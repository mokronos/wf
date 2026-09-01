import path from "node:path"
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

export const dashboardIsEmbedded = Object.keys(assets).length > 0
const dashboardSourceDirectory = path.resolve(import.meta.dir, "..", "..", "..", "apps", "wf", "web", "dist")

const dashboardFileResponse = async (pathname: string): Promise<Response> => {
  const location = path.resolve(dashboardSourceDirectory, pathname === "/" ? "index.html" : pathname.slice(1))
  const contained = location === dashboardSourceDirectory || location.startsWith(`${dashboardSourceDirectory}${path.sep}`)
  if (!contained) return new Response("Not found", { status: 404 })
  const file = Bun.file(location)
  if (!(await file.exists())) {
    return new Response(`Dashboard assets not found at ${dashboardSourceDirectory}. Run: bun run --cwd apps/wf/web build`, { status: 404 })
  }
  return new Response(file, { headers: { "content-type": mimeTypeFor(location) } })
}

export const dashboardResponse = async (pathname: string): Promise<Response> => {
  if (!dashboardIsEmbedded) return dashboardFileResponse(pathname)
  const asset = assets[pathname === "/" ? "/index.html" : pathname]
  if (asset === undefined) return new Response("Not found", { status: 404 })
  return new Response(Buffer.from(asset.base64, "base64"), {
    headers: { "content-type": asset.contentType.length === 0 ? mimeTypeFor(pathname) : asset.contentType }
  })
}
