# Chrome 即時原文翻譯雙語字幕

這是一個可用 Chrome「載入未封裝項目」安裝的 Manifest V3 擴充功能。它擷取目前選取分頁的音訊，可選擇 Deepgram 或 Gemini 3.5 Transcribe Live 產生原文，再交由 Custom LLM 或 Gemini 文字模型翻譯成台灣繁體中文，最後在原分頁顯示可供 OBS 擷取的雙語字幕。使用者可在 Popup 輸入自己的 API key 與服務設定。

## 架構

```text
Active Chrome tab
    ↓ chrome.tabCapture stream ID
Service worker
    ↓
Offscreen document
    ├─ MediaStream → AudioContext destination（保留本地聲音）
    ├─ AudioWorklet → mono / 16 kHz / signed Int16 PCM
    ├─ Deepgram Streaming WebSocket
    │    └─ Translation Scheduler → Custom LLM 或 Gemini GenerateContent
    └─ Gemini Transcribe Live WebSocket → 原文 transcript
                                      └─ Translation Scheduler
                                      ↓
Content script + Shadow DOM subtitle overlay
```

元件分工：

- `background/service-worker.js`：接收 Popup 指令、取得目前分頁、建立 offscreen document、取得 tab capture stream ID、維護與轉送狀態。
- `offscreen/offscreen.js`：管理 MediaStream、AudioContext、AudioWorklet、Deepgram、翻譯排程及完整 Start/Stop 生命週期。
- `offscreen/audio-worklet.js`：將來源多聲道混成 mono，以低成本方式降採樣至 16 kHz，並輸出 signed 16-bit little-endian PCM。
- `offscreen/deepgram-client.js`：建立 Streaming WebSocket、分別解析 Nova v1 與 Flux v2，再正規化為統一的 interim/final segment。
- `offscreen/gemini-transcribe-client.js`：串流 16 kHz PCM 至 Gemini 3.5 Transcribe Live，接收自動語言偵測的 interim/final 原文，再交給共用翻譯排程。
- `offscreen/gemini-text-client.js`：呼叫 Gemini GenerateContent API，讓 Flash-Lite 翻譯 Deepgram 文字。
- `offscreen/custom-llm-client.js`：呼叫使用者設定的 OpenAI-compatible `/chat/completions`，處理 timeout、HTTP、網路及 JSON 錯誤。
- `offscreen/translation-scheduler.js`：以約 600 ms 節奏翻譯持續更新的 interim 片段、同時最多一個 interim request、final 優先；完整原文與已完成的 interim 翻譯一致時，直接沿用該翻譯，並防止舊 response 覆蓋已完成字幕。
- `content/subtitle-overlay.js`：以 Shadow DOM 顯示可拖曳、可調寬、可調字體與背景透明度的雙語字幕；上方保留最近一組翻譯完成後便鎖定的字幕。下方句子切段後會繼續顯示，直到翻譯完成才搬到上方，並在同一次交接中顯示下一句。等待期間的新原文與即時翻譯會暫存，已切段的句子依序交接；上方每句至少顯示 1 秒，避免多句結果同時回傳時跳句。因此翻譯較慢時，下一句的顯示也會延後。
- `popup/`：字幕控制、API key 與 Custom LLM 連線設定、字幕外觀及即時預覽。

API key 只由擴充功能頁面與 offscreen document 讀取，透過 Chrome 儲存區的 trusted contexts 限制避免 content script 存取。

音訊與 WebSocket 放在 offscreen document，不依賴 Popup 持續開啟，也不把長時間工作完全放在可能被 Chrome suspend 的 service worker。

## API 設定

第一次使用時，點擊外掛圖示並開啟 **API 設定**：

- 在 **Deepgram** 輸入語音辨識用 API key。
- 在 **Gemini** 輸入 Gemini API key；Gemini 語音辨識與翻譯共用同一把 key。
- 在 **Custom LLM** 輸入 OpenAI 相容的 Chat Completions Base URL 與 Model ID。API key 可留空，供不需驗證的服務使用。
- 每個服務可選擇「僅本次瀏覽器工作階段」或「記住此裝置」。憑證不會同步到其他 Chrome 裝置；Chrome 儲存區不等同加密保險箱。
- 「測試連線」會實際呼叫服務；Custom LLM 測試會送出一個很短的生成請求，可能產生少量費用。

Base URL 可填到 API 根路徑，例如 `http://localhost:8000/v1`，也可直接填到 `/chat/completions`。首次連線自訂主機時，Chrome 會要求該主機的存取權限；拒絕後不會開始擷取。

模型選擇、服務連線與字幕外觀都由 Popup 管理。`config.js` 只保存非機密的服務端點、模型預設值與行為參數，不應放入任何 API key。

Nova-3 使用 `/v1/listen` 與 `Results` 訊息；Flux 使用 `/v2/listen` 與 `TurnInfo` 訊息。Flux English 固定辨識英文；Flux Multilingual Auto 使用 `flux-general-multi` 且不傳 `language_hint`，由 Deepgram 自動偵測支援的來源語言。所有 profile 會正規化為相同字幕 segment。Flux 的 `Update` 對應 interim，`EndOfTurn` 對應 final；由於連續轉播可能長時間沒有 `EndOfTurn`，客戶端會優先依句尾標點切段，最長約 16 個原文詞彙，並保留 4 個詞作為可修正尾巴。模型只能在停止擷取時切換，選擇結果保存於 `chrome.storage.local`。

Gemini 3.5 Transcribe Live 是 Deepgram 的替代 STT 管線：PCM 音訊直接送到 Gemini，使用 `interimInputTranscription` 顯示低延遲原文，並以 finalized `inputTranscription` 建立正式字幕；來源語言由 Gemini 自動偵測。原文仍交由 Popup 選擇的 Custom LLM 或 Gemini 文字模型翻成繁中。Gemini Live session 會在接近 9 分 30 秒時提交當前片段並建立新 session，以符合單一 session 最長 10 分鐘的限制。官方文件：[Live Transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)。
## Installation

先下載本專案 ZIP 並解壓縮，或使用 Git：

```sh
git clone https://github.com/HorCyChangGenitek/chrmExt_realtime_sub.git
cd chrmExt_realtime_sub
```

這是直接載入原始碼的擴充功能，不需要安裝 npm 套件或執行建置。語音辨識與翻譯服務需要自行準備帳號與 API key，可能產生服務費用。

1. 在 Chrome 開啟 `chrome://extensions`。
2. 開啟右上角 **Developer mode**。
3. 選擇 **Load unpacked**。
4. 選擇本專案根目錄，也就是包含 `manifest.json` 的資料夾。
5. 將擴充功能固定在 Chrome 工具列。
6. 點擊外掛圖示，在 **API 設定**輸入要使用的服務憑證與連線資訊。
7. 修改任何程式後，在 `chrome://extensions` 對本擴充功能按 **Reload**；已開啟的測試頁面也應重新整理。使用工作階段儲存的 key 需重新輸入。

本專案要求 Chrome 116 或更新版本，因為 tab capture stream ID 會由 service worker 交給 offscreen document 使用。

## Usage

1. 開啟有支援語言音訊的 YouTube 或其他一般 `http`/`https` 頁面。
2. 點擊擴充功能圖示。
3. 在 **字幕控制**選擇語音辨識與翻譯模型。若選用的服務尚未設定，依提示前往 **API 設定**輸入 key。
4. 按 **Start Capture**。
5. 首次連線自訂 LLM 主機時，允許 Chrome 顯示的主機權限要求。
6. 播放影片。
7. 確認原文 interim/final 字幕出現。
8. 確認繁體中文字幕出現。
9. 可在 **字幕外觀**調整字體、寬度、背景透明度及顯示語言，也可直接拖曳字幕上方的把手。
10. 使用 **Stop Capture** 結束。Stop 會取消翻譯、關閉 WebSocket 與 AudioContext，並停止所有 MediaStream tracks。

Chrome 內建頁面（例如 `chrome://extensions`）、Chrome Web Store 及其他禁止 content script 的受保護頁面不能使用。

## OBS

字幕是目前頁面內、最高 z-index 的半透明 Shadow DOM overlay。進入播放器全螢幕時，字幕會掛載至 fullscreen element，並利用 manual Popover 重新進入瀏覽器 top layer，因此全螢幕內仍可拖曳及保存位置；不支援 Popover 時則保留 fullscreen element 掛載作為 fallback。可使用 OBS 的視窗擷取或瀏覽器畫面擷取。若只想保留中文字幕，可在 Popup 關閉原文顯示。OBS 不會直接讀取此擴充功能的 offscreen document。

## 建議測試順序

請不要一次同時判斷所有元件，依下列順序測試：

```text
1. tabCapture 是否成功。
2. 使用者是否仍聽得到聲音。
3. AudioWorklet 是否持續產生 PCM。
4. Deepgram 是否成功連線。
5. Deepgram interim transcript 是否正常。
6. Deepgram final transcript 是否正常。
7. 翻譯 API 是否正常回覆。
8. interim translation 是否正常取消舊 request。
9. final subtitle 是否正確鎖定。
10. Stop 後是否完整釋放資源。
```

建議先開啟 Debug Mode。`Audio statistics` 中：

- `sourceSampleRate` 是 AudioContext 實際取樣率。
- `targetSampleRate` 應為 `16000`。
- 音訊運作時 `bytesPerSecond` 通常約為 `32000`（16,000 samples × 2 bytes），WebSocket 短暫重連時可能有差異。
- `rms` 與 `peak` 可協助判斷分頁目前是否真的有聲音。
- `websocketState` 應在正常串流時顯示 `OPEN`。

## 測試 Custom LLM API

Popup 的 **API 設定**頁提供「測試連線」。測試會呼叫目前填入的 URL 與 Model ID，成功後只在目前 Popup 顯示結果；輸入中的 key 可直接測試，測試不會自動儲存憑證。

若連線失敗，可先在執行 Chrome 的主機確認 API server 正在執行、Base URL 與 `/v1` 路徑正確，以及服務允許擴充功能的 Origin。跨主機連線時，服務必須監聽 LAN 可達的介面並由防火牆限制可連線來源。擴充功能會在首次連線時要求設定中該主機的精確存取權限。

Custom LLM request 由擴充功能的 offscreen document 發出，不是由普通網頁 content script 發出。企業政策、瀏覽器安全設定、CORS 或 API 網路配置仍可能阻擋請求。
## 狀態與錯誤

Popup 分別顯示整體 Connection、Speech 與 Translator 狀態。可見狀態包括：

- `Idle`
- `Capturing`
- `Deepgram Connected`
- `Translator Connected`
- `Translating`
- `Stopped`
- `Error`

Deepgram 會在非正常關閉後最多重連 `config.js` 指定的次數，延遲為 1、2、4 秒，最長不超過 8 秒，不會無限快速重連。重連期間最多暫存約兩秒 PCM，避免記憶體無限制增加。

Custom LLM interim request 同時最多一個；較新的 interim 會用 AbortController 取消舊 request。final request 不會被 interim 取消，並以 segment ID 更新對應 final 中文字幕。Stop 時所有未完成的 interim 與 final request 都會取消。

## Troubleshooting

### Extension 無法安裝或 Manifest error

- 確認選到包含 `manifest.json` 的根目錄，而不是它的上一層。
- 使用 Chrome 116 或更新版本。
- 查看 `chrome://extensions` 顯示的詳細錯誤。
- 修改檔案後按 Reload，並重新整理測試分頁。

### Offscreen document error

- 確認 Chrome 版本符合要求。
- 在 `chrome://extensions` 的擴充功能詳細頁檢查 service worker console。
- Stop 後再 Start；若剛 Reload 擴充功能，先重新整理目標頁。

### No active tab / Cannot capture tab

- Start 必須由使用者在 Popup 主動點擊。
- 先選取一般 `http` 或 `https` 網頁。
- 不支援 `chrome://`、Chrome Web Store 或其他受保護頁面。
- 其他正在使用 tab capture 的擴充功能可能造成衝突。

### 聲音消失

offscreen document 會把擷取的 MediaStream 重新接到 `audioContext.destination`。若仍無聲音：

- 確認分頁本身及系統混音器未靜音。
- Stop 後重新播放，再 Start。
- 查看 AudioContext 是否進入 `running`。
- 檢查 service worker 與 offscreen console 是否有 MediaStream 或 AudioContext 錯誤。

### Deepgram 401 或 WebSocket 失敗

- 確認 Popup 的 **API 設定**已儲存正確且有效的 Deepgram API key。
- 確認防火牆或代理允許 `wss://api.deepgram.com`。
- Nova-3 必須使用 `/v1/listen`；Flux 必須使用 `/v2/listen`，不要只改 model 名稱。
- 確認 Deepgram 帳號具有所選模型的存取權。
- 401/authorization error 不會把完整 API Key 寫入 Debug Log。
- 429 或 rate limit 時請等待配額恢復，不要提高重連次數。

### Extension context invalidated

這通常發生在 `chrome://extensions` 按 Reload 後，原網頁仍保留舊 content script。新版已避免將失效的訊息傳送顯示為未捕捉錯誤，但舊 script 無法自行恢復；Reload Extension 後仍應重新整理影片頁面。

### 沒有 transcript

- 先確認 Debug Mode 的 `bytesPerSecond`、`rms`、`peak` 不為零。
- 使用 Nova-3 English 時，確認播放內容主要是英文，並確認 `language` 為 `en-US`；多語自動偵測請改選 Flux Multilingual Auto。
- 若 WebSocket 是 `OPEN` 但音訊統計為零，來源分頁可能沒有播放音訊。
- 若 PCM 正常但沒有文字，檢查 Deepgram console 訊息、model 與帳號權限。

### Custom LLM connection refused、timeout 或 Network Error

- 從同一台 Windows 主機執行 `Test-NetConnection` 及 `Invoke-RestMethod`。
- 確認 Base URL、port、`/v1` 路徑與 Model ID。
- 跨主機時不要只監聽 `127.0.0.1`。
- 確認 Windows 防火牆允許 port。
- 若先前拒絕 Chrome 權限，再按測試連線或 Start 並允許設定中的 origin；也可在擴充功能網站存取設定中檢查權限。
- 某些 API server 仍會自行驗證 `Origin`。若明確回傳 CORS 錯誤，應在服務或反向代理允許擴充功能 origin，或改由本地 backend 代理。

### 翻譯速度過慢或字幕跳動

- 選擇較小的 Custom LLM model 或改善推論硬體。
- 避免以大量平行 request 補償慢速。
- interim 約每 600 ms 取最新片段翻譯；可提高 `translation.interimCadenceMs` 降低請求頻率，或降低它讓中文更新更快。
- 太短、只有冠詞的片段會延後翻譯，屬於預期行為。

### final 被 interim 覆蓋

final 英文會先建立獨立 segment，final 中文依 segment ID 回填；interim 只更新目前未完成區塊。若看到錯置，開啟 Debug Mode，記錄 segment ID、sequence 與時間後再檢查。

### Stop 後仍顯示 Capturing

- 關閉 Popup 再重新開啟，狀態會由 offscreen document 同步。
- 在 `chrome://extensions` 查看錯誤。
- 若擴充功能剛被 Reload，舊頁面的 content script 已失效；重新整理測試頁。
- Reload 擴充功能會強制中止舊 extension context，但網頁上的舊 Shadow DOM 可能要到頁面重新整理才消失。

## 儲存與隱私

`chrome.storage.local` 保存：

- 字體大小
- 字幕寬度
- 字幕背景透明度
- Deepgram 模型 profile
- 原文顯示開關
- 中文顯示開關
- Debug Mode
- 字幕視窗位置
- API 服務連線資訊（不含 API key）

API key 依使用者選擇存放於 `chrome.storage.session` 或 `chrome.storage.local`。前者會在瀏覽器結束、外掛重新載入或更新後清除；後者保留於目前 Chrome 設定檔且不會同步。擴充功能會限制這兩個儲存區僅供受信任的擴充功能頁面使用。

逐字稿與翻譯不會寫入 storage；畫面只保留最近一組 final 字幕。音訊會送到使用者選擇的語音服務，辨識出的原文會送到設定的翻譯服務。

## Security warning

使用者輸入的 API key 存在自己的 Chrome 設定檔，不會包進擴充功能原始碼或跨裝置同步；Chrome 儲存區不是加密保險箱。key 由擴充功能信任範圍內的 Popup、service worker 與 offscreen document 使用，content script 無法讀取。請保護自己的作業系統帳號與 Chrome 設定檔，若 key 曾貼入對話、Issue 或其他紀錄，應旋轉該 key。

若產品改為所有使用者共用開發者的 API 額度，應改由受控 backend 代理供應商 API，並在 backend 實作認證、速率限制、允許來源及稽核。Gemini Live 的伺服器代管架構應使用受限的短效 token。

## 已知限制

- 只能擷取使用者按 Start 時選取的單一 Chrome 分頁，不擷取麥克風或整台電腦。
- 不支援 Chrome 受保護頁面。
- F11 瀏覽器全螢幕通常可正常顯示；網站播放器的 Fullscreen API 會透過 top-layer Popover 處理，但原生 `<video>`、跨來源 iframe 或網站自訂播放器仍可能受 Chrome 或網站實作限制。
- AudioWorklet 針對常見的 44.1/48 kHz 輸入做降採樣；它不是高階音樂用途的帶限重採樣器，但輸出格式與 Deepgram 宣告一致。
- Deepgram 重連期間可能遺失超過有限暫存量的音訊。
- Custom LLM 的速度、模型品質、API 相容性、CORS/Origin 行為及網路可達性取決於使用者部署。
- 擴充功能 Reload、Chrome 結束或目標分頁 reload/navigation 會中止目前擷取，需要重新 Start。
- 目前字幕 overlay 適用 OBS 視窗/畫面擷取，不提供透明背景的獨立 Browser Source URL。

## 靜態驗證

開發測試使用 Node.js 22 或更新版本，不需要額外套件。在專案根目錄執行：

```sh
node --test tests/*.test.mjs
```

測試涵蓋字幕切段、翻譯交接與全螢幕控制的模擬行為；不會連線外部 API，也不能取代 Chrome 中的實際擷取測試。

交付前應確認：

- `manifest.json` 是合法 JSON，且所有引用檔案存在。
- manifest 與 HTML 內沒有 inline JavaScript，也沒有遠端 JavaScript。
- extension runtime 程式不使用 Node.js API、CommonJS `require()` 或 `eval`。
- JavaScript import 都能由本地相對路徑解析。
- AudioWorklet 以 `chrome.runtime.getURL()` 載入。
- Deepgram URL 宣告 `linear16`、16 kHz、mono，實際傳送 Int16 PCM binary frame。
- Custom LLM endpoint 不會重複 `/v1/v1`。
- Stop 會清除 timer、AbortController、WebSocket、AudioContext、AudioNode 與 MediaStream tracks。
- 程式使用四個空格縮排，不混用 Tab。

本專案本身不包含使用者 API key、自訂 LLM 服務或可互動的 Chrome 測試環境；因此僅靠原始碼靜態檢查不能宣稱外部連線、實際音訊擷取或端到端字幕已成功。

## 提交與回報問題

提交程式或回報 Issue 前，請移除 API key、Authorization header、私人服務位址及含敏感資訊的逐字稿或截圖。請在 Issue 附上 Chrome 版本、使用的語音與翻譯模型、重現步驟及已遮蔽敏感資訊的錯誤訊息。

`.gitignore` 會排除常見本機憑證、環境檔與產出物，但無法阻止把密鑰直接寫入原始碼。API key 請一律由擴充功能的 **API 設定**輸入。

## 授權

本專案採用 [MIT License](LICENSE)。外部語音辨識與翻譯服務的使用仍須遵守各供應商的條款與計費規則。
