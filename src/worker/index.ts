import { Hono } from "hono"
import { cors } from "hono/cors"

const CATEGORIES = ["餐飲", "交通", "日用品", "娛樂", "醫療", "教育", "其他"]

const GEMINI_MODEL = "gemini-2.0-flash"
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"

type Env = {
  DB: D1Database
  LINE_CHANNEL_SECRET: string
  LINE_CHANNEL_ACCESS_TOKEN: string
  GEMINI_API_KEY?: string
}

type LlmResult =
  | { intent: "bookkeeping"; entry: { date: string; category: string; amount: number; memo?: string }; reply: string }
  | { intent: "other"; reply: string }

const app = new Hono<{ Bindings: Env }>()

app.use("/*", cors({ origin: "*" }))

// ---------- Gemini：意圖判斷 + 記帳欄位 + 人性化回覆 ----------
async function callGemini(apiKey: string, userMessage: string, today: string): Promise<LlmResult | null> {
  const systemPrompt = `你是記帳 LINE Bot 的助手。根據用戶訊息判斷意圖，並回傳「僅一行」的 JSON，不要 markdown 或註解。

規則：
1. 若用戶在記一筆支出（有金額、可推得類別或備註），intent 為 "bookkeeping"，並填 entry：date(YYYY-MM-DD，缺則用 ${today})、category(限：${CATEGORIES.join("、")})、amount(數字)、memo(可選)。
2. 其餘（問候、問功能、閒聊、無法辨識為記帳）intent 為 "other"，不需 entry。
3. reply 一律填一句給用戶的「人性化回覆」：記帳成功就簡短確認；非記帳就簡短友善回覆。

回傳格式（任一種）：
{"intent":"bookkeeping","entry":{"date":"...","category":"...","amount":123,"memo":"..."},"reply":"..."}
{"intent":"other","reply":"..."}`

  const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const body = {
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n用戶說：${userMessage}` }] }],
    generationConfig: { responseMimeType: "application/json" },
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as LlmResult
    if (parsed.intent === "bookkeeping" && parsed.entry && CATEGORIES.includes(parsed.entry.category) && Number(parsed.entry.amount) > 0) {
      return parsed
    }
    if (parsed.intent === "other" && typeof parsed.reply === "string") return parsed
    return { intent: "other", reply: parsed.reply ?? "收到，有需要記帳跟我說～" }
  } catch {
    return { intent: "other", reply: "剛剛沒解析成功，再講一次或用：類別 金額 備註" }
  }
}

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
  const today = new Date().toISOString().slice(0, 10)
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue
    const text = (ev.message.text ?? "").trim()
    let replyText: string
    if (c.env.GEMINI_API_KEY) {
      const llm = await callGemini(c.env.GEMINI_API_KEY, text, today)
      if (llm?.intent === "bookkeeping" && llm.entry) {
        const { date, category, amount, memo } = llm.entry
        await c.env.DB.prepare(
          "INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)"
        )
          .bind(date, category, amount, memo ?? null)
          .run()
        replyText = llm.reply
      } else {
        replyText = llm?.reply ?? "收到，有需要記帳跟我說～"
      }
    } else {
      const parsed = parseLineEntry(text)
      if (parsed) {
        const date = parsed.date ?? today
        await c.env.DB.prepare(
          "INSERT INTO entries (date, category, amount, memo) VALUES (?, ?, ?, ?)"
        )
          .bind(date, parsed.category, parsed.amount, parsed.memo ?? null)
          .run()
        replyText = `已記一筆：${date} ${parsed.category} ${parsed.amount} 元${parsed.memo ? " " + parsed.memo : ""}`
      } else {
        replyText = "格式：類別 金額 [備註]\n類別可填：餐飲、交通、日用品、娛樂、醫療、教育、其他\n例：餐飲 120 午餐"
      }
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
