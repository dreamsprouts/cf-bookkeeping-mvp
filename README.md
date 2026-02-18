# CF Bookkeeping MVP

**目的**：用「日常記帳」情境，最簡方式測通 Cloudflare 前後端部署流程。

**目標受眾**：自己（熟悉 Cloudflare Workers / Pages / D1 與 LINE + Gemini 整合）。

---

## 要做什麼（MVP 範圍）

| 環節 | 說明 |
|------|------|
| **LINE** | 發訊息到 Bot |
| **Gemini LLM** | 接訊息、回覆使用者，並把內容轉成**標準記帳格式** |
| **API + DB** | 標準格式透過 API 寫入資料庫（Cloudflare D1） |
| **前端** | 一個頁面：檢視 DB 裡的記帳資料，並可透過 UI 編輯 |

---

## 技術選型（最小化）

- **後端 / API**：Cloudflare Workers（單一 Worker 處理 LINE webhook + 內部 API）
- **資料庫**：Cloudflare D1（SQLite）
- **前端**：Cloudflare Pages（靜態頁 + 呼叫同專案 Worker API）
- **LINE**：Messaging API（webhook 接收訊息）
- **LLM**：Google Gemini API（回覆 + 結構化抽取）

記帳標準格式建議：`{ date, category, amount, memo }`（可再微調）。

---

## 在 GitHub 建立 Repo（你做一次）

我無法代你在 GitHub 建立 repository，請任選一種方式：

### 方式 A：網頁

1. 打開 https://github.com/new
2. Owner 選 `dreamsprouts`
3. Repository name 建議：`cf-bookkeeping-mvp`（或你喜歡的名稱）
4. 選 Public，不勾 Initialize with README（本地已有）
5. Create repository 後，照頁面上的「push an existing repository」執行：

```bash
cd ~/Projects/cf-bookkeeping-mvp
git remote add origin https://github.com/dreamsprouts/cf-bookkeeping-mvp.git
git branch -M main
git push -u origin main
```

### 方式 B：GitHub CLI（若已安裝 `gh`）

```bash
cd ~/Projects/cf-bookkeeping-mvp
gh repo create dreamsprouts/cf-bookkeeping-mvp --public --source=. --remote=origin --push
```

---

## 環境與密鑰（之後部署時需要）

- **LINE**：Channel secret、Channel access token（Messaging API）
- **Gemini**：API key（Google AI Studio）
- **Cloudflare**：Account 與 `wrangler` 登入；D1 database 建立後會得到 binding 名稱

以上會寫在 `wrangler.toml` 與 Workers 環境變數，不會 commit 密鑰本身。

---

## 專案目錄結構（預計）

```
cf-bookkeeping-mvp/
├── README.md
├── wrangler.toml          # Workers + D1 + 變數
├── src/
│   └── worker/            # Worker 入口：LINE webhook、API 路由
├── db/
│   └── schema.sql         # D1 建表
└── frontend/              # Pages 前端（或同 monorepo 的 static）
    └── ...
```

實際結構會隨實作微調。

---

## 下一步

1. **你**：在 GitHub 建立 repo 並 push（見上方步驟）。
2. **我**：依你確認後，開始 scaffold Worker（LINE webhook、Gemini、D1）、schema 與最小前端頁（列表 + 編輯）。

若你想改專案名稱、記帳欄位或技術選型，直接說即可。
