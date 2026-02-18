import { CATEGORIES } from "./line"

const GEMINI_MODEL = "gemini-3-flash-preview"
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
const GEMINI_TIMEOUT_MS = 15000

export type LlmResult =
  | { intent: "bookkeeping"; entry: { date: string; category: string; amount: number; memo?: string }; reply: string }
  | { intent: "other"; reply: string }

/** 對應 LlmResult 的 JSON Schema，強制模型回傳結構（減少 thinking 混入） */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["bookkeeping", "other"] },
    entry: {
      type: "object",
      properties: {
        date: { type: "string" },
        category: { type: "string" },
        amount: { type: "number" },
        memo: { type: "string" },
      },
      required: ["date", "category", "amount"],
    },
    reply: { type: "string" },
  },
  required: ["intent", "reply"],
}

function buildPrompt(today: string): string {
  return `你是記帳 LINE Bot。規則：只要用戶訊息裡「有數字（金額）」且能推測花費項目，一律當記帳，intent 填 "bookkeeping"，不要填 "other"。
類別必須從這七個選一：${CATEGORIES.join("、")}。
對應：奶茶/飲料/手搖/咖啡/便當/午餐/晚餐/吃飯/零食→餐飲；買書/書籍→教育；車票/捷運/加油/停車→交通；電影/遊戲→娛樂；藥/看診→醫療；日常用品→日用品；無法歸類→其他。
entry：date 用 ${today}（除非用戶寫日期）、category 從上七選一、amount 從訊息中的數字、memo 用用戶寫的項目（如「奶茶」「誠品買書」）。
reply：用一句「像真人」的簡短回覆。記帳時要根據用戶寫的內容變化（可提到項目或金額），不要每則都同一句、不要制式罐頭，例如「好，奶茶 50 記好了～」「記好了，300 元書錢」；非記帳（打招呼、問功能、沒金額）才用 "other"，回覆也要自然簡短。

只回傳一行 JSON，不要 markdown。
{"intent":"bookkeeping","entry":{"date":"...","category":"...","amount":123,"memo":"..."},"reply":"..."}
或 {"intent":"other","reply":"..."}`
}

/** 只取 part.text（忽略 thoughtSignature）。三層 fallback：直接 parse → strip fence → 擷取 { } 區塊 */
function parsePartToResult(part: { text?: string; thoughtSignature?: string }): LlmResult | null {
  const t = part.text?.trim()
  if (!t) return null
  const attempts = [
    t,
    (() => { const m = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/); return m ? m[1].trim() : null })(),
    (() => { const start = t.indexOf("{"); const end = t.lastIndexOf("}"); return start >= 0 && end > start ? t.slice(start, end + 1) : null })(),
  ].filter((s): s is string => typeof s === "string" && s.length > 0)
  for (const raw of attempts) {
    try {
      const parsed = JSON.parse(raw) as LlmResult
      if (parsed.intent === "bookkeeping" || parsed.intent === "other") return validateResult(parsed)
    } catch { continue }
  }
  return null
}

function validateResult(parsed: LlmResult): LlmResult {
  if (
    parsed.intent === "bookkeeping" &&
    parsed.entry &&
    CATEGORIES.includes(parsed.entry.category) &&
    Number(parsed.entry.amount) > 0
  ) {
    return parsed
  }
  if (parsed.intent === "other" && typeof parsed.reply === "string") {
    return parsed
  }
  return { intent: "other", reply: (parsed.reply ?? "").trim() || "收到，有需要記帳跟我說～" }
}

export async function callGemini(apiKey: string, userMessage: string, today: string): Promise<LlmResult> {
  const url = `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const payload = {
    contents: [{ role: "user", parts: [{ text: `${buildPrompt(today)}\n\n用戶說：${userMessage}` }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timeoutId)
    if ((e as Error).name === "AbortError") {
      return { intent: "other", reply: "[錯誤] Gemini 逾時，請再試一次" }
    }
    return { intent: "other", reply: `[錯誤] Gemini 連線失敗: ${(e as Error).message}` }
  }
  clearTimeout(timeoutId)

  const raw = await res.text()
  if (!res.ok) {
    console.error("[Gemini] API error", res.status, raw.slice(0, 500))
    return { intent: "other", reply: `[除錯] Gemini HTTP ${res.status}` }
  }

  type PartsItem = { text?: string; thoughtSignature?: string }
  let data: { candidates?: Array<{ content?: { parts?: PartsItem[] } }> }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    console.error("[Gemini] response body not JSON", raw.slice(0, 300))
    return { intent: "other", reply: "[除錯] Gemini 回傳非 JSON" }
  }

  const parts = data.candidates?.[0]?.content?.parts
  if (!parts || parts.length === 0) {
    console.warn("[Gemini] no parts", JSON.stringify(data).slice(0, 400))
    return { intent: "other", reply: "[除錯] Gemini 空回傳" }
  }

  for (const part of parts) {
    const result = parsePartToResult(part)
    if (result) {
      console.log("[Gemini] parsed", result.intent, result.reply?.slice(0, 80))
      return result
    }
  }

  parts.forEach((p, i) => console.error("[Gemini] part", i, "text", p.text?.slice(0, 200)))
  return { intent: "other", reply: "[除錯] Gemini 回傳無法解析為 JSON" }
}
