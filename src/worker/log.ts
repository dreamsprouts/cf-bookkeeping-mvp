export async function appendLog(db: D1Database, level: string, message: string, meta?: string) {
  try {
    await db.prepare("INSERT INTO logs (level, message, meta) VALUES (?, ?, ?)")
      .bind(level, message, (meta ?? "").slice(0, 1000))
      .run()
  } catch (e) {
    console.error("[appendLog]", e)
  }
}
