# CF Bookkeeping MVP — 前後端分離（Cloudflare）

- **前端**：Cloudflare **Pages**（靜態站）
- **後端**：Cloudflare **Workers** + D1（API）
- 兩個網址，前端用 fetch 呼叫後端 API。

---

## 架構

| 角色 | 產品 | 網址 |
|------|------|------|
| 前端 | Pages | `https://cf-bookkeeping-mvp.pages.dev` |
| 後端 API | Workers + D1 | `https://cf-bookkeeping-mvp.morris-dreamsprouts.workers.dev` |

---

## 第一次：安裝 + D1

```bash
cd ~/Projects/cf-bookkeeping-mvp
npm install
```

D1 若還沒建過：

```bash
npm run db:create
```

把終端印出的 `database_id` 貼進 **wrangler.toml** 替換 `REPLACE_AFTER_D1_CREATE`。  
然後建表（本機 + 遠端各一次）：

```bash
npm run db:migrate:local
npm run db:migrate
```

---

## 部署

### 透過 GitHub 自動部署（建議，同 Vercel / Render）

Push 到 `main` 或 `master` 會觸發 GitHub Actions，自動部署 **Worker** 與 **Pages**。

**一次性設定：**

1. 到 GitHub repo → **Settings** → **Secrets and variables** → **Actions**，新增兩個 Secrets：
   - **`CLOUDFLARE_API_TOKEN`**：到 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左側 **My Profile** → **API Tokens** → **Create Token**，選 **Edit Cloudflare Workers** 範本，權限足夠即可，建立後複製。
   - **`CLOUDFLARE_ACCOUNT_ID`**：Dashboard 右側欄或 **Workers & Pages** 任一頁網址列中的 `dash.cloudflare.com/<account_id>/...`，即為 Account ID。

2. Pages 專案若尚未建立，本機執行一次即可（之後由 CI 部署）：
   ```bash
   npx wrangler pages project create cf-bookkeeping-mvp --production-branch=master
   ```

之後只要 `git push`，就會自動部署；不需在本機跑 `npm run deploy`。

---

### 手動部署（本機）

**後端（API）：**

```bash
npm run deploy
```

**前端（Pages）：**

第一次需先建立 Pages 專案（只需做一次）：

```bash
npx wrangler pages project create cf-bookkeeping-mvp --production-branch=master
```

然後部署前端：

```bash
npm run deploy:frontend
```

完成後用瀏覽器開 **https://cf-bookkeeping-mvp.pages.dev** = 前端；前端會呼叫 Workers 的 API，列表有資料 = 前後端分離測通。

---

## 本機開發

- 後端：`npm run dev` → API 在 http://localhost:8787  
- 前端：直接開 `frontend/index.html`（會打線上 API），或用任意 static server 開 `frontend/`。  
  若要在本機打本機 API，改 `frontend/index.html` 裡的 `API_BASE` 為 `http://localhost:8787` 即可。

---

## LINE 接通

Bot 接收用戶訊息後：**有設定 Gemini API key 時**，一律經 LLM 判斷意圖（記帳則寫入 D1 + 人性化回覆；其餘則只回人性化訊息）；**未設定時**則僅支援固定格式解析並寫入 D1。

---

### LINE 後台要做哪些設定（兩邊都要做）

若出現「本帳號無法個別回覆用戶的訊息」，代表官方帳號尚未允許用 Bot/API 回覆，需在以下兩處設定。

#### 1. LINE Developers Console（開發者後台）

網址：<https://developers.line.biz/console/>

1. 選你的 **Provider** → 點進對應的 **Channel**（Messaging API 類型）。
2. 上方切到 **「Messaging API」** 頁籤。
3. **Webhook settings**：
   - 點 **Edit**，Webhook URL 填：  
     `https://cf-bookkeeping-mvp.morris-dreamsprouts.workers.dev/webhook/line`  
     再按 **Update**。
   - 把 **Use webhook** 設為 **Enabled**（開啟）。
   - 按 **Verify**，應出現 **Success**（代表你的 Worker 有正確回 200）。
4. （可選）**Line Login** 等其它頁籤不用動；Channel secret、Channel access token 已在 Basic settings / Messaging API 頁籤，且已用 `wrangler secret put` 設到 Worker。

#### 2. LINE Official Account Manager（官方帳號管理後台）

網址：<https://manager.line.biz/>

1. 選你要用的 **官方帳號**（例如小米米）。
2. 右上 **設定**（齒輪）→ **回應設定**。
3. **回應模式**：
   - 若目前是「不回應」或「僅發送訊息」（廣播），用戶傳訊息時就會出現「本帳號無法個別回覆」。
   - 改為可回覆的模式，例如：
     - **聊天**：可手動回覆，也可搭配 Webhook 讓你的 Bot 回覆。
     - **聊天機器人**：以自動回應／Webhook 為主。
4. 在 **設定** 裡找到 **「Messaging API」** 或 **「與開發者後台連動」** 相關選項，確認有 **啟用** 或 **允許以 API 回覆**（依畫面用語為準），這樣 Webhook 收到訊息後，你用 Reply API 送出的回覆才會真的發給用戶。
5. 儲存後，用 LINE 再傳一次「餐飲 120 午餐」測試；應會收到 Bot 回覆「已記一筆：…」。

兩邊都設好後，流程是：用戶傳訊 → LINE 打你的 Webhook → Worker 解析、寫 D1、呼叫 Reply API → 用戶看到回覆。

---

**Webhook URL（同上，填在 Developers Console）：**

```
https://cf-bookkeeping-mvp.morris-dreamsprouts.workers.dev/webhook/line
```

**訊息格式：**

- `類別 金額 [備註]`  
  例：`餐飲 120 午餐`、`交通 50`
- 可選開頭加日期：`YYYY-MM-DD 類別 金額 [備註]`  
  例：`2026-02-18 娛樂 300 電影`

**類別**限用：餐飲、交通、日用品、娛樂、醫療、教育、其他。  
格式不符時 Bot 會回覆格式說明。

**設定密鑰：**

- **Production（Workers）**：在專案目錄執行  
  `wrangler secret put LINE_CHANNEL_SECRET`、  
  `wrangler secret put LINE_CHANNEL_ACCESS_TOKEN`  
  依提示貼上 Channel secret 與 Channel access token（Messaging API 頁籤）。
- **本機**：複製 `.dev.vars.example` 為 `.dev.vars`，填入上述兩項（不要 commit `.dev.vars`）。

### Gemini 設定（選填，啟用 LLM 回覆）

1. **取得 API key**  
   - 開啟 [Google AI Studio](https://aistudio.google.com/) → 登入 Google 帳號。  
   - 左側或上方選 **「Get API key」／「取得 API 金鑰」**。  
   - 建立或選擇專案後，點 **Create API key**，複製金鑰。

2. **設定到 Worker**  
   - **Production**：在專案目錄執行  
     `wrangler secret put GEMINI_API_KEY`  
     依提示貼上剛才複製的 API key。  
   - **本機**：在 `.dev.vars` 加上一行  
     `GEMINI_API_KEY=你的_gemini_api_key`  
     （可參考 `.dev.vars.example`。）

設定完成後，LINE 訊息會改由 Gemini 判斷意圖並回覆人性化內容；未設定則維持固定格式解析。
