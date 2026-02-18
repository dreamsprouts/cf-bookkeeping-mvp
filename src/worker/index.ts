import { Hono } from "hono"
import { cors } from "hono/cors"

const CATEGORIES = ["餐飲", "交通", "日用品", "娛樂", "醫療", "教育", "其他"]

const GEMINI_MODEL = "gemini-3-flash-preview"
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

async function appendLog(db: D1Database, level: string, message: string, meta?: string) {
  try {
    await db.prepare("INSERT INTO logs (level, message, meta) VALUES (?, ?, ?)")
      .bind(level, message, (meta ?? "").slice(0, 1000))
      .run()
  } catch (e) {
    console.error("[appendLog]", e)
  }
}

// ---------- Gemini：意圖判斷 + 記帳欄位 + 人性化回覆 ----------
async function callGemini(apiKey: string, userMessage: string, today: string): Promise<LlmResult | null> {
  const systemPrompt = `你是記帳 LINE Bot。規則：只要用戶訊息裡「有數字（金額）」且能推測花費項目，一律當記帳，intent 填 "bookkeeping"，不要填 "other"。
類別必須從這七個選一：${CATEGORIES.join("、")}。
對應：奶茶/飲料/手搖/咖啡/便當/午餐/晚餐/吃飯/零食→餐飲；買書/書籍→教育；車票/捷運/加油/停車→交通；電影/遊戲→娛樂；藥/看診→醫療；日常用品→日用品；無法歸類→其他。
entry：date 用 ${today}（除非用戶寫日期）、category 從上七選一、amount 從訊息中的數字、memo 用用戶寫的項目（如「奶茶」「誠品買書」）。
reply：用一句「像真人」的簡短回覆。記帳時要根據用戶寫的內容變化（可提到項目或金額），不要每則都同一句、不要制式罐頭，例如「好，奶茶 50 記好了～」「記好了，300 元書錢」；非記帳（打招呼、問功能、沒金額）才用 "other"，回覆也要自然簡短。

只回傳一行 JSON，不要 markdown。
{"intent":"bookkeeping","entry":{"date":"...","category":"...","amount":123,"memo":"..."},"reply":"..."}
或 {"intent":"other","reply":"..."}`

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
  const raw = await res.text()
  if (!res.ok) {
    console.error("[Gemini] API error", res.status, raw.slice(0, 500))
    return { intent: "other", reply: `[除錯] Gemini API 錯誤 HTTP ${res.status}，詳見 wrangler tail` }
  }
  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  try {
    data = JSON.parse(raw) as typeof data
  } catch (e) {
    console.error("[Gemini] response not JSON", raw.slice(0, 300), e)
    return { intent: "other", reply: "[除錯] Gemini 回傳非 JSON，詳見 wrangler tail" }
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!text) {
    console.warn("[Gemini] no text in response", JSON.stringify(data).slice(0, 400))
    return { intent: "other", reply: "[除錯] Gemini 無有效內容（空回傳），詳見 wrangler tail" }
  }
  console.log("[Gemini] raw", text.slice(0, 400))
  try {
    const parsed = JSON.parse(text) as LlmResult
    if (parsed.intent === "bookkeeping" && parsed.entry && CATEGORIES.includes(parsed.entry.category) && Number(parsed.entry.amount) > 0) {
      console.log("[Gemini] ok bookkeeping", parsed.entry)
      return parsed
    }
    if (parsed.intent === "other" && typeof parsed.reply === "string") {
      console.log("[Gemini] ok other", parsed.reply?.slice(0, 80))
      return parsed
    }
    console.warn("[Gemini] validation failed", { intent: parsed.intent, category: "entry" in parsed ? parsed.entry?.category : undefined, amount: "entry" in parsed ? parsed.entry?.amount : undefined })
    return { intent: "other", reply: (parsed.reply ?? "").trim() || "收到，有需要記帳跟我說～" }
  } catch (e) {
    console.error("[Gemini] JSON parse fail", text.slice(0, 200), e)
    return { intent: "other", reply: "[除錯] Gemini 回傳格式解析失敗，詳見 wrangler tail" }
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
  await appendLog(c.env.DB, "webhook", "received", `events=${events.length}`)
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.replyToken) continue
    const text = (ev.message.text ?? "").trim()
    let replyText = ""
    try {
      await appendLog(c.env.DB, "line", "user", text.slice(0, 200))
      if (c.env.GEMINI_API_KEY) {
        const llm = await callGemini(c.env.GEMINI_API_KEY, text, today)
        await appendLog(c.env.DB, "gemini", llm ? (llm.intent === "bookkeeping" ? "bookkeeping" : "other") : "null", llm ? JSON.stringify(llm).slice(0, 300) : "")
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
      replyText = replyText.slice(0, 500)
      await appendLog(c.env.DB, "line", "reply", replyText.slice(0, 200))
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await appendLog(c.env.DB, "error", errMsg, (e instanceof Error ? (e.stack ?? "") : "").slice(0, 500))
      replyText = "[錯誤] 伺服器異常，請稍後再試"
    }
    if (!replyText) replyText = "[錯誤] 伺服器異常，請稍後再試"
    const replyRes = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: replyText }] }),
    })
    if (!replyRes.ok) {
      await appendLog(c.env.DB, "error", "LINE reply failed", `${replyRes.status} ${await replyRes.text()}`)
    }
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
// 查 log（後端介面，方便排查 webhook / Gemini）
app.get("/api/logs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit")) || 100, 200)
  const { results } = await c.env.DB.prepare(
    "SELECT id, created_at, level, message, meta FROM logs ORDER BY id DESC LIMIT ?"
  )
    .bind(limit)
    .all()
  return c.json(results)
})

// 測通 Gemini：GET 此 URL 會用「奶茶 50」呼叫 Gemini 並回傳結果
app.get("/api/test-gemini", async (c) => {
  if (!c.env.GEMINI_API_KEY) {
    return c.json({ ok: false, error: "GEMINI_API_KEY 未設定" }, 500)
  }
  const today = new Date().toISOString().slice(0, 10)
  try {
    const result = await callGemini(c.env.GEMINI_API_KEY, "奶茶 50", today)
    return c.json({ ok: true, result, today })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    return c.json({ ok: false, error: errMsg }, 500)
  }
})

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
