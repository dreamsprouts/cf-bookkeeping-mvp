-- 記帳一筆：日期、類別、金額、備註
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);

-- 後端 log（webhook / Gemini / 錯誤），供 GET /api/logs 查詢
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
