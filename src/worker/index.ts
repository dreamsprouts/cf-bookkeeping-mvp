import { Hono } from "hono"
import { cors } from "hono/cors"

const CATEGORIES = ["餐飲", "交通", "日用品", "娛樂", "醫療", "教育", "其他"]

type Env = {
  DB: D1Database
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
}

const app = new Hono<{ Bindings: Env }>()

app.use("/*", cors({ origin: "*" }))

// ---------- LINE Webhook（需 raw body 驗簽，單獨處理）----------
app.post("/webhook/line", async (c) => {
  const rawBody = await c.req.text()
  // LINE 後台按 Verify 時會送 events: []，直接回 200 讓驗證通過
  try {
    const probe = JSON.parse(rawBody) as { events?: unknown[] }
    if (Array.isArray(probe.events) && probe.events.length === 0) {
      return c.json({ ok: true })
    }
  } catch {
    // 非 JSON 或格式不對，繼續驗簽
  }
  const sig = c.req.header("x-line-signature")
  if (!sig || !c.env.LINE_CHANNEL_SECRET) {
    return c.json({ error: "missing signature or secret" }, 401)
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(c.env.LINE_CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  )
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  if (sig !== expected) {
    return c.json({ error: "invalid signature" }, 401)
  }
  const body = JSON.parse(rawBody) as { events?: Array<{ type: string; replyToken?: string; message?: { type: string; text?: string } }> }
  const events = body.events ?? []
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue
    const text = (ev.message.text ?? "").trim()
    const parsed = parseLineEntry(text)
    let replyText: string
    if (parsed) {
      const date = parsed.date ?? new Date().toISOString().slice(0, 10)
      await c.env.DB.prepare(
        "INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)"
      )
        .bind(date, parsed.category, parsed.amount, parsed.memo ?? null)
        .run()
      replyText = `已記一筆：${date} ${parsed.category} ${parsed.amount} 元${parsed.memo ? " " + parsed.memo : ""}`
    } else {
      replyText = "格式：類別 金額 [備註]\n類別可填：餐飲、交通、日用品、娛樂、醫療、教育、其他\n例：餐飲 120 午餐"
    }
    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: replyText }] }),
    })
  }
  return c.json({ ok: true })
})

function parseLineEntry(text: string): { date?: string; category: string; amount: number; memo?: string } | null {
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
  // 可選開頭 YYYY-MM-DD
  let i = 0
  let date: string | undefined
  if (/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) {
    date = parts[0]
    i = 1
  }
  if (i >= parts.length - 1) return null
  const category = parts[i]
  const amount = Number(parts[i + 1])
  if (!CATEGORIES.includes(category) || Number.isNaN(amount)) return null
  const memo = parts.slice(i + 2).join(" ") || undefined
  return { date, category, amount, memo }
}

// ---------- API ----------
// 列出所有筆
app.get("/api/entries", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM entries ORDER BY created_at DESC").all()
  return c.json(results)
})

// 新增一筆
app.post("/api/entries", async (c) => {
  const body = await c.req.json<{ date?: string; category?: string; amount?: number; memo?: string }>()
  const date = body.date ?? new Date().toISOString().slice(0, 10)
  const category = body.category ?? "其他"
  const amount = Number(body.amount) || 0
  const memo = body.memo ?? null
  await c.env.DB.prepare(
    "INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)"
  )
    .bind(date, category, amount, memo)
    .run()
  return c.json({ ok: true })
})

// 更新一筆
app.put("/api/entries/:id", async (c) => {
  const id = c.req.param("id")
  const body = await c.req.json<{ date?: string; category?: string; amount?: number; memo?: string }>()
  await c.env.DB.prepare(
    "UPDATE entries SET date=?, category=?, amount=?, memo=?, updated_at=datetime('now') WHERE id=?"
  )
    .bind(body.date ?? "", body.category ?? "", Number(body.amount) ?? 0, body.memo ?? null, id)
    .run()
  return c.json({ ok: true })
})

// 健康檢查：確認 API Worker 在跑
const healthPayload = () => ({
  ok: true,
  service: "cf-bookkeeping-mvp",
  timestamp: new Date().toISOString(),
})
app.get("/health", (c) => c.json(healthPayload()))
app.get("/", (c) => c.json(healthPayload()))

export default app
