const CATEGORIES = ["餐飲", "交通", "日用品", "娛樂", "醫療", "教育", "其他"]

export { CATEGORIES }

export function parseLineEntry(text: string): { date?: string; category: string; amount: number; memo?: string } | null {
  const parts = text.split(/\s+/).filter(Boolean)
  if (parts.length < 2) return null
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

export async function verifySignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  return signature === expected
}

export async function replyLine(token: string, replyToken: string, text: string): Promise<Response> {
  return fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  })
}
