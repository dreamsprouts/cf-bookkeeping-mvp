-- 延伸 entries：誰（LINE user）、幣別、發生時間、支付方式
-- 僅給「已建過舊表」的 DB 執行一次；新安裝請直接用 db/schema.sql（已含完整欄位）

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'cash',
  created_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO payment_methods (id, name, type) VALUES (1, '錢包現金', 'cash');

ALTER TABLE entries ADD COLUMN line_user_id TEXT;
ALTER TABLE entries ADD COLUMN currency TEXT DEFAULT 'TWD';
ALTER TABLE entries ADD COLUMN occurred_at TEXT;
ALTER TABLE entries ADD COLUMN payment_method_id INTEGER DEFAULT 1;
