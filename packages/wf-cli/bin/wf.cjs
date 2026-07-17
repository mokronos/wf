#!/usr/bin/env node
const childProcess = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const binary = process.platform === "win32" ? "wf.exe" : "wf"
const platform = process.platform === "win32" ? "windows" : process.platform
const arch = os.arch()
const base = `@mokronos/wf-${platform}-${arch}`
const isMusl = () => {
  if (platform !== "linux") return false
  try {
    return process.report.getReport().header.glibcVersionRuntime === undefined
  } catch {
    return false
  }
}
const candidates = platform === "linux"
  ? (isMusl() ? [`${base}-musl`, base] : [base, `${base}-musl`])
  : [base]

const run = (target) => {
  const child = childProcess.spawn(target, process.argv.slice(2), { stdio: "inherit" })
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.on("SIGINT", () => forwardSignal("SIGINT"))
  process.on("SIGTERM", () => forwardSignal("SIGTERM"))
  process.on("SIGHUP", () => forwardSignal("SIGHUP"))
  child.on("error", (error) => { console.error(error.message); process.exit(1) })
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(typeof code === "number" ? code : 1)
  })
}

if (process.env.WF_BIN_PATH) { run(process.env.WF_BIN_PATH) }
else {
  let target
  for (const name of candidates) {
    try {
      const pkg = require.resolve(`${name}/package.json`)
      const candidate = path.join(path.dirname(pkg), "bin", binary)
      if (fs.existsSync(candidate)) { target = candidate; break }
    } catch {}
  }
  if (target) run(target)
  else {
    console.error(`wf does not provide a binary for ${platform}-${arch}. Reinstall @mokronos/wf or set WF_BIN_PATH to a compatible binary.`)
    process.exit(1)
  }
}
