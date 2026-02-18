import { Hono } from "hono"
import { cors } from "hono/cors"
import { appendLog } from "./log"
import { callGemini } from "./gemini"
import type { LlmResult } from "./gemini"
import { CATEGORIES, parseLineEntry, verifySignature, replyLine } from "./line"

type Env = {
  DB: D1Database
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY?: string
  executionCtx?: ExecutionContext
}

const app = new Hono<{ Bindings: Env }>()

app.use("/*", cors({ origin: "*" }))

// ---------- LINE Webhook ----------
app.post("/webhook/line", async (c) => {
  const rawBody = await c.req.text()

  try {
    const probe = JSON.parse(rawBody) as { events?: unknown[] }
    if (Array.isArray(probe.events) && probe.events.length === 0) {
      return c.json({ ok: true })
    }
  } catch { /* not JSON or malformed, continue */ }

  const sig = c.req.header("x-line-signature")
  if (!sig || !c.env.LINE_CHANNEL_SECRET) {
    return c.json({ error: "missing signature or secret" }, 401)
  }
  if (!(await verifySignature(c.env.LINE_CHANNEL_SECRET, rawBody, sig))) {
    return c.json({ error: "invalid signature" }, 401)
  }

  const body = JSON.parse(rawBody) as {
    events?: Array<{ type: string; replyToken?: string; message?: { type: string; text?: string } }>
  }
  const events = body.events ?? []
  const today = new Date().toISOString().slice(0, 10)
  await appendLog(c.env.DB, "webhook", "received", `events=${events.length}`)

  const messageEvents = events.filter(
    (ev): ev is typeof ev & { replyToken: string; message: { text?: string } } =>
      ev.type === "message" && ev.message?.type === "text" && !!ev.replyToken
  )

  async function processEvents() {
    for (const ev of messageEvents) {
      const text = (ev.message.text ?? "").trim()
      let replyText = ""
      try {
        await appendLog(c.env.DB, "line", "user", text.slice(0, 200))
        if (c.env.GEMINI_API_KEY) {
          const llm: LlmResult = await callGemini(c.env.GEMINI_API_KEY, text, today)
          await appendLog(c.env.DB, "gemini", llm.intent, JSON.stringify(llm).slice(0, 300))
          if (llm.intent === "bookkeeping" && llm.entry) {
            const { date, category, amount, memo } = llm.entry
            await c.env.DB.prepare("INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)")
              .bind(date, category, amount, memo ?? null)
              .run()
            replyText = llm.reply
          } else {
            replyText = llm.reply
          }
        } else {
          const parsed = parseLineEntry(text)
          if (parsed) {
            const date = parsed.date ?? today
            await c.env.DB.prepare("INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)")
              .bind(date, parsed.category, parsed.amount, parsed.memo ?? null)
              .run()
            replyText = `已記一筆：${date} ${parsed.category} ${parsed.amount} 元${parsed.memo ? " " + parsed.memo : ""}`
          } else {
            replyText = `格式：類別 金額 [備註]\n類別可填：${CATEGORIES.join("、")}\n例：餐飲 120 午餐`
          }
        }
        replyText = replyText.slice(0, 500)
        await appendLog(c.env.DB, "line", "reply", replyText.slice(0, 200))
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        await appendLog(c.env.DB, "error", errMsg, (e instanceof Error ? (e.stack ?? "") : "").slice(0, 500))
        replyText = "[錯誤] 伺服器異常，請稍後再試"
      }
      if (!replyText) replyText = "[錯誤] 伺服器異常，請稍後再試"
      const replyRes = await replyLine(c.env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, replyText)
      if (!replyRes.ok) {
        await appendLog(c.env.DB, "error", "LINE reply failed", `${replyRes.status} ${await replyRes.text()}`)
      }
    }
  }

  if (c.env.executionCtx && messageEvents.length > 0) {
    c.env.executionCtx.waitUntil(processEvents())
    return c.json({ ok: true })
  }
  await processEvents()
  return c.json({ ok: true })
})

// ---------- API ----------
app.get("/api/logs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 100, 200)
  const { results } = await c.env.DB.prepare(
    "SELECT id, created_at, level, message, meta FROM logs ORDER BY id DESC LIMIT ?"
  ).bind(limit).all()
  return c.json(results)
})

app.get("/api/test-gemini", async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ ok: false, error: "GEMINI_API_KEY 未設定" }, 500)
  const today = new Date().toISOString().slice(0, 10)
  try {
    const result = await callGemini(c.env.GEMINI_API_KEY, "奶茶 50", today)
    return c.json({ ok: true, result, today })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.post("/api/test-webhook", async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ ok: false, error: "GEMINI_API_KEY 未設定" }, 500)
  const today = new Date().toISOString().slice(0, 10)
  let body: { text?: string }
  try { body = await c.req.json() } catch { return c.json({ ok: false, error: "body 需為 JSON" }, 400) }
  const text = (body.text ?? "").trim() || "奶茶 50"
  try {
    const llm = await callGemini(c.env.GEMINI_API_KEY, text, today)
    return c.json({
      ok: true,
      reply: llm.reply,
      intent: llm.intent,
      entry: llm.intent === "bookkeeping" ? llm.entry : null,
    })
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.get("/api/entries", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM entries ORDER BY created_at DESC").all()
  return c.json(results)
})

app.post("/api/entries", async (c) => {
  const body = await c.req.json<{ date?: string; category?: string; amount?: number; memo?: string }>()
  const date = body.date ?? new Date().toISOString().slice(0, 10)
  const category = body.category ?? "其他"
  const amount = Number(body.amount) || 0
  const memo = body.memo ?? null
  await c.env.DB.prepare("INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)")
    .bind(date, category, amount, memo)
    .run()
  return c.json({ ok: true })
})

app.put("/api/entries/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ date?: string; category?: string; amount?: number; memo?: string }>()
  await c.env.DB.prepare("UPDATE entries SET date=?, category=?, amount=?, memo=?, updated_at=datetime('now') WHERE id=?")
    .bind(body.date ?? "", body.category ?? "", Number(body.amount) ?? 0, body.memo ?? null, id)
    .run()
  return c.json({ ok: true })
})

const healthPayload = () => ({
  ok: true,
  service: "cf-bookkeeping-mvp",
  timestamp: new Date().toISOString(),
})
app.get("/health", (c) => c.json(healthPayload()))
app.get("/", (c) => c.json(healthPayload()))

export default {
  fetch(request: Request, env: Omit<Env, "executionCtx">, ctx: ExecutionContext) {
    return app.fetch(request, { ...env, executionCtx: ctx })
  },
}
