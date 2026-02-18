#!/usr/bin/env node
/**
 * 本機 E2E：起 dev、打 POST /api/test-webhook、檢查 ok + reply。
 * 通過才上線。用法：node scripts/e2e-webhook.mjs 或 npm run test:e2e
 */
import { spawn } from "child_process"
import { setTimeout as sleep } from "timers/promises"

const BASE = "http://127.0.0.1:8787"
const WAIT_MS = 15000
const POLL_MS = 500

async function waitForDev() {
  const start = Date.now()
  while (Date.now() - start < WAIT_MS) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return true
    } catch (_) {}
    await sleep(POLL_MS)
  }
  return false
}

async function runTest() {
  const cases = [
    { text: "奶茶 50", label: "記帳" },
    { text: "嗨", label: "招呼" },
  ]
  for (const { text, label } of cases) {
    const res = await fetch(`${BASE}/api/test-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })
    const data = await res.json()
    if (!data.ok || !data.reply || typeof data.reply !== "string") {
      console.error(`E2E 失敗 [${label}] "${text}":`, data)
      return false
    }
    console.log(`E2E 通過 [${label}] "${text}" →`, data.reply?.slice(0, 50))
  }
  return true
}

const child = spawn("npx", ["wrangler", "dev"], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
})
child.unref()
let killed = false
function cleanup() {
  if (!killed && child.pid) {
    killed = true
    process.kill(-child.pid, "SIGTERM")
  }
}
process.on("exit", cleanup)
process.on("SIGINT", () => { cleanup(); process.exit(130) })

await sleep(2000)
if (!(await waitForDev())) {
  console.error("dev 未在時限內就緒")
  cleanup()
  process.exit(1)
}
const ok = await runTest()
cleanup()
process.exit(ok ? 0 : 1)
