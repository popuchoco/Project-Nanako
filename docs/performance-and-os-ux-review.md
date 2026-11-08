# OS 操作體驗與效能檢視

本文件整理公開專案的操作模式與效能原則，並記錄 Nanako 的實作決策及封裝量測。這些專案僅供研究與介面概念參考，沒有複製或匯入其原始碼、圖片、圖示、字型或其他資產，因此不列入 `THIRD_PARTY.md`。

## 參考專案與適用範圍

### ChromeOS

使用者提供的 [chromeos/chromeos.dev](https://github.com/chromeos/chromeos.dev) 是 ChromeOS 開發者網站，不是 ChromeOS 桌面環境或系統 UI 的原始碼。它可作為內容與資訊導覽的參考，但不適合用來判斷 OS 操作動畫或執行期記憶體。因此，系統流程的參照改以 ChromiumOS 公開架構文件為準：把啟動區分為基本服務、系統應用程式及非必要服務；讓必要 UI 儘早可用，非必要工作延後或平行執行，並避免讓非關鍵工作卡住啟動畫面。[ChromeOS 開機流程](https://www.chromium.org/chromium-os/chromiumos-design-docs/boot-design/) [軟體架構](https://new.chromium.org/chromium-os/chromiumos-design-docs/software-architecture/)

### B2G／Gaia

[mozilla-b2g/B2G](https://github.com/mozilla-b2g/B2G) 已於 2021 年封存並標示為棄用；它是含 Gecko、裝置平台與 Gaia 的完整作業系統專案，不是可直接套用在 Windows／Electron 的桌面外殼。[B2G 專案狀態](https://github.com/mozilla-b2g/B2G)

 [Gaia System UI](https://github.com/mozilla-b2g/gaia/blob/master/apps/system/index.html) 將視窗容器、狀態列、快速設定面板及系統按鈕放在單一系統介面中；啟動畫面所需內容優先載入，其他初始化指令延後執行，並提供 lazy loader。其應用程式視窗由系統 UI 動態管理。[系統介面骨架](https://github.com/mozilla-b2g/gaia/blob/master/apps/system/index.html) [視窗管理](https://github.com/mozilla-b2g/gaia/blob/master/apps/system/js/applications.js) [延遲載入工具](https://github.com/mozilla-b2g/gaia/blob/master/shared/js/lazy_loader.js)

Gaia 的 [window.css](https://github.com/mozilla-b2g/gaia/blob/master/apps/system/style/window.css) 依開啟、關閉、App 間切換及卡片檢視選用不同 transition state；這比所有操作共用一種動畫更能表達操作關係。Nanako 保留這個「動畫回饋對應操作」概念，但因為是 Windows 桌面視窗，不照搬手機全螢幕滑動或長時間縮放。

## 可轉用到 Nanako 的操作原則

1. **先顯示桌面外殼，再載入功能資料**：Nanako 啟動先呈現桌面、應用程式入口與工作列；使用者開啟相簿、播放器、設定等視窗後才讀取該功能資料。暫不把所有媒體索引與縮圖在啟動時預載。
2. **視窗是同一個 renderer 裡的虛擬視窗**：維持單一 Electron `BrowserWindow`，OS 樣式的多視窗繼續由 Nanako UI 模擬。Electron 每增加一個原生 `BrowserWindow`，就會建立一個 renderer；不為每個模擬 App 額外建立原生視窗，以免增加程序與記憶體負擔。[Electron 程序模型](https://www.electronjs.org/docs/latest/tutorial/process-model)
3. **最小化保留工作狀態，關閉釋放大型資料**：最小化仍保留視窗內容，符合桌面工作流程；關閉檔案管理器、相簿與播放器時移除對應的大型 DOM／媒體項目，播放器另會停止播放並清除媒體來源。重新開啟時再載入。
4. **漸進呈現而非一次建立全部節點**：檔案清單每批建立 100 列，相簿每批最多建立 48 張圖片卡片，圖片使用瀏覽器原生 lazy loading 與非同步解碼；播放清單每批建立 48 筆。需要更多項目時由使用者明確載入下一批。API 目前仍限制媒體分類最多 1,000 筆中繼資料，檔案清單仍一次載入目前資料夾項目；若大量資料測試出 metadata／回應瓶頸，再改為伺服器端游標分頁。
5. **短促且可關閉的視窗動畫**：新視窗以 160 毫秒的位移／淡入呈現，只動畫 `transform` 與 `opacity`；保留 `prefers-reduced-motion`。不以模糊、陰影擴散或寬高動畫製造長時間 GPU／版面工作。
6. **效能先量測再最佳化**：Electron 官方效能建議是先用 profiler 找到啟動、閒置、操作中的資源熱點；避免啟動即載入不需要的模組與資料，耗時工作不應阻塞 renderer。[Electron 效能指引](https://www.electronjs.org/docs/latest/tutorial/performance)

## 封裝容量基準與已採取的縮減

以下是本機 0.2.0 可攜式 x64 封裝的建置前基準；容量是檔案系統量測，不代表執行期 RAM：

| 項目 | 基準 | 說明 |
| --- | ---: | --- |
| 可攜式單檔 EXE | 110,717,514 bytes（約 105.5 MiB） | Electron／Chromium 執行環境是主要體積來源 |
| `resources/app.asar` | 8,925,000 bytes（約 8.5 MiB） | Nanako 程式與執行期相依套件 |
| `@zip.js/zip.js` 套件目錄 | 約 8.32 MiB | 其中約 5.75 MiB 是本專案 Node.js 執行路徑不使用的 `dist/` 發行集合 |
| Chromium 語系檔 | 55 個、約 48.82 MiB（未壓縮） | 目前發行設定原本保留全部語系 |

已在 Windows 封裝設定中只保留 `en-US` 與 `zh-TW` 兩種 Chromium 語系，並排除 zip.js 未使用的瀏覽器發行集合、開發說明與型別宣告；保留實際執行所需程式、WASM、授權檔及 Chromium 授權聲明。比較時同時量測 EXE 與 `app.asar`，不能以未壓縮語系容量直接推算單檔 EXE 的縮小幅度。`app.asar` 是封裝格式，不應宣稱它本身會壓縮程式碼。

以相同專案版本、Electron 45.2.2、Windows x64 重新封裝至獨立效能測試目錄後，單檔可攜式 EXE 為 102,815,898 bytes（約 98.05 MiB），比基準少 7,901,616 bytes（約 7.14%）；`app.asar` 為 2,635,573 bytes（約 2.51 MiB），比基準少 6,289,427 bytes（約 70.47%）。語系檔從 55 個／48.82 MiB 減到 2 個／1.13 MiB。單檔縮減比例較低，因為 Electron／Chromium runtime 仍是主要固定成本。封裝後已檢查 `app.asar` 保留 zip.js Node 執行程式、WASM 與授權檔，且排除 `dist/`；封裝輸出位於 `work/perf-build`，沒有覆寫含使用者資料的 `dist/NanakoData`。

不移除 Chromium／Electron 核心、媒體播放所需元件或授權文件來追求表面容量下降。未來若需要再降低發行檔，先檢查重複資產及實際執行期相依，再決定是否建立精簡 bundle；FFmpeg、個別 codec 與其他解碼器仍依既有媒體相容性決策處理。

## 記憶體基準與後續量測

目前只有單一 Windows 電腦的一次初始 RAM 基準，尚無跨裝置可比較資料；以下數字不能用來宣稱記憶體已減少特定百分比。

### Windows 單機初始實測（2026-11-08）

在 Windows 10 專業版 x64（build 19045）、AMD Ryzen 5 7600、15.15 GiB 可見實體記憶體的電腦，使用 Electron 45.2.2 與 commit `0970ca1` 執行 [Windows 記憶體量測腳本](../scripts/measure-windows-memory.ps1)。測試建立獨立可攜式資料目錄及一次性本機管理員，只使用合成檔案：根目錄 1,000 個文字檔、1,000 張 1×1 PNG、1,000 筆影音索引（999 個空白 MP3 與一段由 Chromium `MediaRecorder` 產生的 167,444-byte WebM）。影片實際播放成功，解析度 320×180、`readyState=4`。測完後腳本關閉 Electron 並刪除整個合成 `NanakoData`；不會改動使用者資料、SMB、Windows 服務或防火牆。

每個互動階段約每兩秒取樣六次並取中位數；閒置基準是在首頁載入首批 100 列後先等 60 秒，播放器／所有視窗關閉後分別再等 30 秒。Process tree 數字是 Nanako Electron 主程序與其 renderer、GPU、utility 等子程序各自的計數器加總；Working Set 加總會重複計入程序間共享頁面，不等同唯一實體 RAM。Private Bytes 為各程序 `PrivateMemorySize64` 加總；Renderer 欄只計 `--type=renderer` 程序的 Private Bytes。全程維持一個 renderer。

| 狀態 | 全程序 Working Set 中位數 | 全程序 Private Bytes 中位數 | Renderer Private Bytes 中位數 |
| --- | ---: | ---: | ---: |
| 閒置 60 秒後；檔案首批 100／共 1,002 項 | 388.18 MiB | 262.58 MiB | 41.11 MiB |
| 檔案清單載入下一批，共 200 列 | 391.42 MiB | 264.19 MiB | 46.51 MiB |
| 相簿首批 48 張／共 1,000 張 | 408.79 MiB | 284.28 MiB | 50.17 MiB |
| 相簿載入下一批，共 96 張 | 407.88 MiB | 291.94 MiB | 50.93 MiB |
| 播放清單首批 48 筆／共 1,000 筆 | 421.13 MiB | 330.47 MiB | 57.99 MiB |
| 播放清單載入全部 1,000 筆 | 437.08 MiB | 353.90 MiB | 75.71 MiB |
| 合成 WebM 播放中 | 444.12 MiB | 325.29 MiB | 75.93 MiB |
| 關閉播放器並等待 30 秒 | 435.25 MiB | 319.87 MiB | 72.38 MiB |
| 檔案視窗開啟／最小化／還原／關閉 20 次 | 458.06 MiB | 340.20 MiB | 85.18 MiB |
| 60 次視窗快速切換後，關閉全部並等待 30 秒 | 457.44 MiB | 375.03 MiB | 82.65 MiB |

這次量測中，關閉播放器後 30 秒 renderer Private Bytes 約比閒置中位數高 31 MiB；完成 20 次視窗循環與 60 次切換、關閉全部視窗並等待 30 秒後，約高 42 MiB。這是需要用 Chromium heap／native memory profiler 重複檢查的**保留記憶體現象**，但單次 Working Set／Private Bytes 取樣不足以判定為記憶體洩漏，也不能區分可重用快取、GC 尚未回收或真正被引用的物件。量測原始 CSV 與 JSON 報告由腳本寫入忽略目錄 `work/memory-measurement-<timestamp>/`；目前這次執行報告位於工作目錄中的 `work/memory-measurement-20261108-183858/`。

後續效能驗收仍需在同一台測試機、同一份 NanakoData 下重複運行並比較：

- 啟動後桌面閒置 60 秒的 Nanako/Electron 整體 Working Set 與 Private Bytes。
- 開啟大量檔案清單（每批 100 列）、1,000 張圖片索引（每批 48 張）時，初始批次與載入下一批的 renderer process 記憶體。
- 開啟 1,000 筆影音佇列後、播放一段影片時、關閉播放器 30 秒後的記憶體回落情形。
- 視窗開啟／最小化／關閉及快速切換連續 20 次後的 renderer 數量、記憶體與 UI 回應時間。
- 可攜式 EXE 與 `app.asar` 的建置前後大小；同一 Electron 版本與架構比較。

## 決策

- 把 ChromeOS／B2G 的系統外殼、延後載入與視窗管理概念轉為 Nanako 自己的 Windows／Electron 實作，不把 Linux／手機 OS 的開機服務或硬體介面照搬過來。
- 上述專案只作為設計研究；未引用其程式碼或資產，所以不新增至 `THIRD_PARTY.md`。
- 不以 Electron 的預設多程序架構誤認為「多開 Nanako 視窗免費」：模擬桌面 App 優先共用目前單一 renderer；未來只有隔離或可靠性需求足以抵銷記憶體成本時，才評估額外程序。
