# 系統架構

> 狀態：早期原型，文件與程式同步更新。最後檢視：2026-11-05。

## 目標與邊界

Project Nanako 是基於 Electron 的 Windows 桌面延伸作品，提供軟體式、本機優先的檔案管理服務。此版本先完成桌面 UI、帳號／權限、檔案基本操作與本機 API 的垂直切片；不依賴專用硬體或雲端帳號。

服務預設僅透過 HTTP 綁定本機迴圈介面。Electron 桌面版可由 Nanako 管理員選擇性啟用第二個 HTTPS listener：只綁定一張已連線的私有 IPv4 網卡，限制到該子網路，使用可驗證 IP SAN 的自簽憑證；私鑰由 Electron `safeStorage`／Windows DPAPI 加密保存。其他裝置登入後會使用同一 Nanako 網頁介面與檔案 API，依權限上傳／下載及管理檔案；這是 HTTPS 網頁存取，不等同 SMB 檔案總管分享。LAN 功能不自動變更 Windows 防火牆或路由器設定，仍待實際多裝置／防火牆組合驗收；命令列模式仍只支援迴圈介面。檔案管理根目錄固定在該發行模式的 `NanakoData\data`；檔案管理、相簿、播放器與資源回收桶皆共用該受限範圍，不提供 Windows 磁碟瀏覽、Known Folder 選擇或外部資料夾掛載功能。

## 元件

```text
Electron 主程序
  ├─ 建立系統匣選單與 BrowserWindow（隔離環境、停用 Node 整合）
  ├─ 啟動同一程序內的 Node.js HTTP 服務
  ├─ 關閉主視窗時隱藏到系統匣；使用者明確退出時關閉服務與 SQLite
  └─ 系統匣點擊可還原視窗，退出命令停止服務
          │ HTTP，127.0.0.1 隨機連接埠
          ▼
Renderer（public/） ─── /api/* ───► HTTP 路由與驗證／授權
                                        ├─ Node.js 內建 SQLite
                                        └─ 本機檔案系統（含 Range 媒體串流）
```

Renderer 的外層以 Nanako 內部桌面呈現捷徑、應用程式入口與本機狀態；應用程式視窗由共用 HTML 範本動態建立，每個應用程式各有一個獨立視窗，並以視窗 Map 管理開啟／最小化狀態、作用中視窗與 z-order。工作列與 Dock 會同步呈現視窗；支援拖曳、方向鍵移動、最小化、最大化／還原、關閉及從工作列還原。視窗生命週期操作會透過本機 `/api/activity` 記錄。功能面板開啟時由隱藏的內容 bank 移入該應用程式視窗，關閉時移回，既有檔案資料操作仍由同一組本機 API 及權限檢查處理。這是應用程式自己的 UI，不會呼叫 Windows Shell。完整操作規則見[桌面互動體驗規劃](ux-interaction-plan.md)。檔案管理支援重新命名、移動、串流複製與逐項批次操作；複製會使用 Nanako 受管理目錄中的隱藏暫存項目，完成後才發布至目的地。重複檔案功能以 Node.js 內建 `crypto` 串流計算 SHA-256，並在確認後將副本移至同一個 Nanako 資料空間的資源回收桶。一般檔案 ZIP 支援串流建立／解壓、進度／取消及暫存復原。加密空間為本機功能原型：只有明確移入的檔案才會轉成 `.nanako-vault` 密文物件，其他 Nanako 檔案仍為一般檔案；備份也只留在同一個 NanakoData，不是異地備份。

- `electron/main.mjs`：桌面生命週期、系統匣、視窗安全設定、啟停 HTTP 服務；桌面煙霧測試模式略過系統匣並保留可自動關閉行為。
- `src/server.mjs`：本機 HTTP API、登入、權限檢查、操作紀錄、檔案／資源回收桶／ZIP 作業、靜態檔案。
- `src/archives.mjs`：限制 NanakoData 路徑範圍的 ZIP 串流建立與解壓縮、中央目錄／路徑／CRC／大小驗證。
- `src/vault-crypto.mjs`：scrypt master-key 包覆、HKDF 物件金鑰派生、AES-256-GCM 區塊串流及加密中繼資料原型；金鑰只由 Node.js 主程序使用。
- `src/vault-backups.mjs`：加密物件備份目錄、AEAD 認證清單、逐物件驗證與串流複製／還原。
- `src/duplicates.mjs`：限定 NanakoData 範圍的檔案列舉、串流 SHA-256 雜湊、進度回報、取消與重複群組整理。
- `src/file-catalog.mjs`：限定單一 Nanako 資料空間、跳過內部目錄及符號連結的圖片／影音／文件遞迴索引；以目錄串流方式列舉，單次最多檢查 100,000 個項目並回傳 1,000 項。
- `src/run.mjs`：供開發及測試使用的命令列啟動器。
- `public/`：繁體中文（台灣）介面，透過同源 HTTP 呼叫 API。
- `test/`：使用暫存資料目錄的 API 整合測試。

## 資料配置

```text
<dataDir>/
  metadata.sqlite       使用者、分享資料夾、權限、工作階段、操作紀錄、續播位置、節流狀態與應用程式設定
  files/<share-id>/     分享資料夾內容
  trash/<share-id>/<id> 待清除或還原的檔案
  .nanako-vault/<user-id>/<object-id>.nkv  各使用者的不透明密文物件
  .nanako-vault/<user-id>/<object-id>.nkm  AEAD 加密中繼資料 sidecar（孤兒復原）
  .nanako-vault/<user-id>/backups/<id>/    僅含密文與經認證清單的本機還原點
```

SQLite 的 `vaults` 表保存密碼與一次性復原金鑰各自包覆的 master key；`vault_objects` 保存隨機物件 UUID、加密中繼資料與回收時間；`vault_pending_imports` 僅記錄不透明物件 ID 與時間，不保存明文路徑。移入時先建立加密 `.nkm` sidecar，再建立密文物件與復原標記。若程序在索引交易前中止，解鎖後會比對 sidecar、完整解密驗證密文與雜湊後列出可復原項目；未索引或無法驗證的檔案不會自動採用，清理需明確確認。來源移除後才清除 pending 標記；若程序在兩者間中止，解鎖後可逐筆雜湊比對，僅在來源內容未變更時由使用者確認移除，也可選擇保留原檔與密文。登入與 vault 解鎖節流列分開保存在 SQLite，未逾期的鎖定在服務重啟後持續生效；超過硬上限時只回收非鎖定列，永不刪除有效鎖定，新鍵在表滿時以既有 429 節流錯誤拒絕。解鎖金鑰留在 Node.js 程序記憶體，不傳給 Renderer；圖片／音訊／影片由受授權 API 串流解密，不建立明文暫存檔。手動鎖定會取消並清理執行中的加解密串流，再清除金鑰參照。Vault 備份會將密文物件、sidecar、索引與 key envelope 收在同一個 NanakoData 下，以 master key 認證清單；不提供異地或外接磁碟路徑。

Windows 可攜式封裝會將設定檔、工作階段及資料分別放在執行檔旁 `NanakoData/profile`、`NanakoData/session`、`NanakoData/data`。NSIS 安裝版以目前 Windows 使用者的 Electron `userData` 為根，於其下建立 `NanakoData/profile`、`NanakoData/session`、`NanakoData/data`；安裝目錄與資料目錄分開，採單使用者安裝，不要求系統管理員提升。Electron 開發與命令列模式會使用專案目錄內的 `NanakoData/data`。目前不提供 UI 選取任意資料根目錄，也不會在可攜式／安裝版之間自動遷移；部署前仍須確定資料備份／還原與升級流程。

所有分享資料夾的實體根目錄均由伺服器組成為 `dataDir/files/<share-id>`；Renderer 只能傳遞分享 ID 與經驗證的相對路徑，不得傳絕對路徑或磁碟代號。匯入檔案是使用者明確選取後複製至 Nanako 管理目錄；應用程式不提供瀏覽、編輯或刪除匯入來源的功能。資源回收桶固定在 `dataDir/trash/<share-id>/<item-id>`，相簿與媒體預覽也只由相同分享根目錄提供。既有資料若含超出範圍的來源紀錄，啟動時會停用該來源中繼資料並清除對應的舊回收桶路徑，不會沿用、搬移或存取其實體路徑。`xdg-user-dirs` 與 Windows Known Folders 均不作為資料根目錄。

重新命名與移動只接受分享根目錄內的相對路徑；不允許操作分享根目錄、覆寫目的項目、跟隨符號連結或將資料夾放入自身子目錄。複製以串流方式處理檔案，整個資料夾複製前先估算項目數與容量，複製期間排除 Nanako 隱藏暫存名稱及資源回收桶內部資料；暫存複製完成後才重新命名為最終項目。批次操作由前端逐項呼叫 API，部分失敗不會回滾已成功的項目，每項結果各自寫入操作紀錄。

## 驗證與授權

- 首次設定只在尚無使用者時建立本機管理員。
- 密碼使用 Node.js `scrypt` 加上每位使用者的隨機 salt 雜湊。
- 隨機工作階段權杖只以 SHA-256 雜湊值寫入 SQLite；瀏覽器 Cookie 設為 `HttpOnly`、`SameSite=Strict`。
- 管理員可建立一般使用者、修改分享資料夾讀寫權限、停用／重新啟用帳號；停用會撤銷現有工作階段。使用者可自行變更密碼，成功後其他工作階段會撤銷。所有 API 檔案操作都在伺服器端檢查權限。
- 登入失敗依帳號與來源位址節流：15 分鐘內錯誤 5 次後暫停 15 分鐘；登入與 vault 解鎖節流分開保存在 SQLite，未逾期鎖定會跨服務重啟保留。超過 2,048 筆時會清理逾期列；若仍超過 4,096 筆只回收非鎖定列，永不驅逐有效鎖定，表滿時新鍵以既有 429 拒絕。
- 管理員限定的電腦資訊 API 會檢查 Windows 系統管理員群組與目前程序完整性等級；使用者帳號具管理員身分不等於程式目前已提升。
- 圖片／音訊／影片透過受權限檢查的 `/api/preview` 提供；支援單一 byte range，以便瀏覽器 seek 影片或音訊。
- 媒體續播位置依使用者與分享路徑保存於 `playback_progress`；每次讀取會重新檢查授權、檔案大小及修改時間，並限制每位使用者最多 500 筆。這些媒體位置不寫入操作紀錄。
- Electron renderer 設定 `contextIsolation` 與 `sandbox`，停用 `nodeIntegration`，並拒絕外部視窗與非本機導覽。

尚未實作密碼重設、多因素驗證、使用者刪除、API token 或遠端授權。Windows 系統管理員權限狀態可以檢視；目前 NSIS 安裝版為不要求提升權限的單使用者安裝，不會安裝服務或提升權限。若要讓一般 Windows 帳號透過受控服務安全存取資料，權限分離流程仍待設計。操作紀錄由本機管理員控制保留與刪除，不是防竄改帳本；不得將本原型的工作階段設計直接用於對外網路服務。

## 加密與封存演進（原型）

加密空間原型使用 Node.js 內建 `crypto`：scrypt 包覆 master key，HKDF 依使用者與隨機物件 UUID 派生獨立內容／中繼資料金鑰，新寫入內容採 128 KiB AES-256-GCM 區塊串流（解碼器仍接受早期 v1 原型寫入的 1 MiB 區塊），中繼資料以 AES-256-GCM 加密。UI 僅能從既有 Nanako 資料空間移入檔案；成功驗證後移除來源路徑。解鎖金鑰由主程序控管，Renderer 不接觸 master key；登出、手動鎖定、閒置或服務關閉會取消並清理執行中的串流，再撤銷可清除的金鑰參照。復原金鑰、加密回收桶、NanakoData 內備份／還原、進度取消、孤兒核對、加密媒體 Range／並行讀取及大檔案記憶體量測已有原型測試；磁碟故障／強制中斷注入、格式獨立安全審查仍是正式使用前的必要工作。

ZIP 只處理一般 Nanako 檔案並以串流方式建立／解壓，進出路徑固定於 NanakoData。建立與解壓都先寫入範圍內的暫存位置，驗證成功後才提交；伺服器拒絕路徑跳脫、符號連結、Zip Slip、衝突路徑及超限項目。ZIP 具有進度／取消，並以 PowerShell 壓縮／解壓命令驗證互通；vault 與 ZIP 分開，避免誤產生明文暫存。

詳細階段、原型 API、金鑰模型及驗收條件見 [加密空間與 ZIP 規劃](feature-plan-encryption-and-archives.md)、[ADR-0009](decisions/ADR-0009-encrypted-vault-design.md) 與 [ADR-0010](decisions/ADR-0010-zip-archive-design.md)。

## 網路與 API 演進

本機 API 與 Electron UI 同源。桌面版由管理員可透過 `POST /api/network/lan` 啟停 LAN HTTPS listener；`GET /api/network` 回報本機與 LAN listener 狀態。使用者憑證、Host、Origin、所選介面與同子網路來源均由服務端驗證；TLS 1.2 以上。LAN 網頁登入後會使用既有檔案 API 完成有權限檢查的上傳／下載。外部裝置需處理自簽憑證信任，Windows 防火牆仍由使用者管理。SMB Server 及 SMB 檔案總管分享尚未實作，但 SMB 是產品必要功能；SMB 實驗性開關只記錄選擇，不會啟動協定服務。共用授權政策現已明確分類 SMB 檔案操作並對未知命令拒絕，仍須先完成 `paltaio/rust-smb-server` Windows localhost／用戶端 POC、安全簽章／加密、逐帳號認證與根目錄隔離，才能進入服務整合；依 [ADR-0015](decisions/ADR-0015-smb-sharing.md) 與 [SMB 實作規劃](smb-implementation-plan.md) 推進。

1. 由使用者明確選取介面／IP、連接埠與是否啟用，預設維持關閉。
2. 避免任意 host、DNS rebinding、跨來源請求及 CSRF；明確驗證 Host、Origin 與授權。
3. TLS 憑證建立／信任、Windows 防火牆規則的建立／移除與錯誤復原。
4. 上傳大小、併發、速率限制、斷線續傳及磁碟空間處理。
5. API 版本、token scope、輪替／撤銷、權限矩陣及 OpenAPI 文件。
6. 網路介面變動、休眠／喚醒、服務重啟與關機的生命週期測試。

未來 API 採本機帳號授權，並提供明確、可撤銷的整合憑證；不導入 SSO 或雲端身份服務作為前提。

## 安全注意事項

目前拒絕路徑跳脫及符號連結，並使用暫存檔完成上傳後再改名；但一般路徑檢查仍可能有檢查與使用間的競爭條件。登入與 vault 解鎖節流狀態會持久化，但尚無面向網路的防護。開放區域網路前須先完成威脅建模、檔案系統競爭測試、安全測試與獨立檢視。

