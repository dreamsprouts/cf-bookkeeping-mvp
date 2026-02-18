-- 支付方式（基本會計：現金、信用卡、帳戶等）
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO payment_methods (id, name, type) VALUES (1, '錢包現金', 'cash');

-- 記帳一筆：日期、類別、金額、備註、誰(LINE)、幣別、發生時間、支付方式
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  memo TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT,
  line_user_id TEXT,
  currency TEXT DEFAULT 'TWD',
  occurred_at TEXT,
  payment_method_id INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_created_at ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_line_user_id ON entries(line_user_id);

-- 後端 log（webhook / Gemini / 錯誤），供 GET /api/logs 查詢
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  meta TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
