# SMB 伺服器概念驗證紀錄

- 日期：2026-11-05
- 驗證環境：Windows x64、Go 1.27.3
- 結果：尚未選定可直接封裝的 SMB Server；本次候選均未匯入 Nanako。

## 驗收門檻

SMB 引擎至少要能在 Windows 執行、可安全綁定指定網卡、支援標準 TCP 445 用戶端連線，並能由服務端強制 Nanako 使用者逐分享資料夾讀取／寫入權限與 `NanakoData` 路徑隔離。僅支援單一共用帳密或僅能讀取檔案，不符合產品需求。

## 候選測試結果

### `paltaio/rust-smb-server`（`smb-server` crate 0.8.0）— 新增待驗證候選

- 來源：[專案原始碼](https://github.com/paltaio/rust-smb-server)、[0.8.0 API 文件](https://docs.rs/smb-server/0.8.0/smb_server/)；MIT 授權，尚未匯入本專案。
- 文件顯示它提供 SMB 2.0.2 至 3.1.1 over TCP、NTLMv2、逐使用者／逐分享讀寫權限、SMB 簽章／加密選項、執行期分享與授權更新，以及以單一根目錄為界的 `LocalFsBackend`。這些能力與 Nanako 的 managed share 模型相符，值得優先做 Windows 概念驗證。
- Rust 1.99.1 工作流程因倉庫的 `warnings = deny` 將新棄用警告升級為錯誤，未進入 crate tests；候選 `Cargo.toml` 宣告 `rust-version = 1.95`，固定 revision `c57fe2c1e58f3bb0882b4e762a89522824d16ccd` 的 Windows `cargo test --workspace` 曾在 CI 通過（[GitHub Actions 執行結果](https://github.com/popuchoco/Project-Nanako/actions/runs/42024119604)）。2026-11-10 又在本機 Windows x64 用 TEMP 內 Rust 1.95.0 與 LLVM MinGW 重跑：候選 workspace tests、`minimal-smb-example` build 及本 repo private harness build 均通過。這些只代表建置／crate tests，不等於產品整合或所有用戶端互通；候選協定限制包括 Kerberos、oplocks／directory leases、DFS、alternate data streams、reparse points 等。
- 身分整合仍有缺口：crate 的帳號設定介面需要 SMB 密碼，而 Nanako 只保存登入密碼的 scrypt verifier，無法還原原始密碼。若無法新增安全的驗證介面，需設計獨立 SMB 密碼的設定、撤銷與持久化；不得把明文 SMB 密碼寫入 SQLite 或一般設定檔。
- 決定：加入 Windows POC 候選，不採用、不開放監聽，也不加入 `THIRD_PARTY.md`。先驗證 Windows 建置、localhost 上 SMB2/3 認證與授權、符號連結／路徑隔離、檔案讀寫／改名／鎖定、簽章／加密與正常停止；再測 Windows、macOS Finder 及 Linux `smbclient`。TCP 445 與 Windows `LanmanServer` 衝突、標準 Windows 用戶端替代連接埠限制仍須獨立解決。

### `sonroyaalmerol/go-smb-server`

- 檢視版本：`d07dc723a2926177b4bc20c806d95cb2c3b1c70a`
- 授權：MIT（候選研究，未匯入本專案）
- 本機 `go test ./...`：失敗，Kerberos 測試 `TestAuthenticator_AcceptUsesInitiatorSubkey` 無法通過。
- 程式碼檢視：SESSION_SETUP 雖保存登入身分，TREE_CONNECT 及 VFS 開檔流程沒有把 Nanako 帳號分享權限落實成授權檢查；不能只接現有 `LocalBackend` 就開放正式服務。
- 決定：不採用目前版本。要採用需先維護 fork、補上身分授權傳遞及安全 VFS，成本與協定風險尚未驗證。

### `malivvan/samba`

- 檢視版本：`236760a9b8c0370edaad68a4a7348acdc9b45ecf`
- 授權：MIT（候選研究，未匯入本專案）
- 自述支援 SMB 2.0.2 至 SMB 3.1.1、NTLMv2、簽章及 SMB3 加密；但其文件明確表示目前授權僅為分享層級，所有登入使用者可存取所有分享，無法符合 Nanako 的逐帳號逐分享權限。
- 本機 Windows `go test ./...`：失敗，涵蓋 Windows 路徑設定解析、檔案控制代碼清理，以及多個協定操作測試；目前不能視為可在 Nanako 發行環境通過的候選。
- 決定：不採用目前版本；需先修正 Windows 測試並補上逐使用者分享授權，再重新做跨用戶端測試。

### `fiddyschmitt/portable-smb-server`

- 檢視版本：`107bb541fbb1c5e848c1b4ebb28f22117c17d523`
- 授權：MIT（候選研究，未匯入本專案）
- 文件描述可攜式、無額外執行環境的 Go 執行檔；目前認證是伺服器共用帳號，協定最高列至 SMB 3.0.2，預設使用 TCP 1445。
- 決定：可作為小型檔案傳輸互通原型候選，但單一共用帳密不符合 Nanako 權限模型；替代連接埠亦須先實測 Windows 原生 SMB 用戶端，不能直接當正式方案。

## 本次 Nanako 程式進度

- 新增 `src/share-access.mjs`，將目前 Nanako 分享權限的唯讀／讀寫判斷集中成可重用政策；未知操作預設拒絕，停用帳號拒絕，SMB 授權模型只接受 managed 分享且禁止外部路徑。
- SMB 前置政策已新增一組正規化的檔案動作分類（目錄查詢、讀取屬性／資料、建立、寫入、截斷、刪除、改名、移動、複製），映射至既有逐分享 Nanako 權限；未辨識的協定／VFS 命令仍 fail-closed。這是後續 SMB Adapter 可重用的授權前置，不包含 SMB 協定處理或監聽器。
- 現有 HTTP 檔案 API 已改用共用權限判斷，避免未來 SMB Adapter 自行複製並偏離 Nanako 權限語意。
- 新增單元測試涵蓋管理員、停用帳號、唯讀帳號、未授權帳號、未知操作與非 Nanako 資料根目錄。
- 這是 SMB 的授權政策前置，不是 SMB 協定服務；目前仍不能從其他裝置連線或宣稱 SMB 已實作。

## 2026-11-10 網頁 LAN 與 SMB 邊界

- 新增的 HTTPS LAN 網頁登入是 Nanako 帳號登入頁與檔案管理 UI，不會建立 SMB 分享、不能在檔案總管輸入 `\\主機\分享`，也不會啟動 Windows `LanmanServer`。
- SMB private harness 與 Windows／Impacket 驗證進度見下方 2026-11-10 POC；候選仍未採用、未加入產品 listener，亦未修改 Windows SMB 服務、TCP 445 或防火牆。

## 2026-11-10 Windows localhost POC 更新

- **環境：** Windows 10 Pro x64，10.0.19045／Build 19045。Rust 1.95.0、rustup 與 LLVM MinGW 僅放在 `%TEMP%`；PATH／LIBRARY_PATH 只於建置程序使用，未修改全域工具鏈、系統／使用者 PATH 或 Windows 服務設定。
- **來源：** `paltaio/rust-smb-server` v0.8.0 固定 revision `c57fe2c1e58f3bb0882b4e762a89522824d16ccd`。Windows `cargo test --workspace`、上游 `minimal-smb-example` build、本 repo `tools/smb-poc` harness build 均通過。harness 只監聽 `127.0.0.1:4445`，使用 `%TEMP%` synthetic `alpha`／`beta` 資料與 `alice`／`bob` 一次性憑證。
- **協定 smoke：** Impacket 0.13.1 固定原始碼 revision `c456746d7a0f0bb25e8968a59f25aae1ad519935`，成功交涉 SMB 3.1.1；Impacket 回報 session signing 啟用且 SMB3 encrypted-session flag 啟用。Alice 的 `alpha` 列舉／讀／寫／建目錄／改名／刪除與 `beta` TREE_CONNECT 成功；Bob 可讀 `alpha`、寫入收到 `STATUS_ACCESS_DENIED`、`beta` TREE_CONNECT 收到 `STATUS_ACCESS_DENIED`；匿名登入收到 `STATUS_LOGON_FAILURE`。重跑腳本：`tools/smb-poc/impacket_smoke.py`。Impacket `storeFile` helper 僅請求 `FILE_WRITE_DATA`，對新檔案 EOF 擴展不適合作為此候選的寫入 smoke；測試改以明確包含 `FILE_APPEND_DATA` 的 CREATE／WRITE 請求，成功完成寫入與清理。
- **Windows client gate：** 本機試用 `\\127.0.0.1@4445\alpha` 收到 Windows error 53，server 記錄第一個 frame 不是 Direct-TCP；該 `@port` 連線形式無效。Windows 10 22H2 沒有 Microsoft 文件所述的 alternate-port mapping client flow；[Microsoft 文件](https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-ports) 指示使用 `New-SmbMapping -TcpPort` 或 `NET USE /TCPPORT`，需求為 Windows 11 24H2+ 或 Windows Server 2025+。Impacket 只能補協定 smoke，不能代替 Windows 原生 client 驗收。
- **Nanako UI gate：** 網路狀態頁新增實驗性 SMB 勾選開關；只接受 `ProductName` 為 Windows 11 且 build ≥ 26100（24H2+）。Windows 10、Windows 11 23H2、非 Windows／無法偵測皆顯示未勾選且禁用；server 端 API 重新檢查 OS，無支援時拒絕啟用並清除舊設定。旗標預設關閉並持久化，但目前只代表設定意願，SMB listener／產品伺服器仍未整合。
- **停止與主機邊界：** Ctrl+C 正常呼叫候選 `shutdown_handle()`；serve loop 返回，並確認候選 TCP 4445 listener 消失。未操作 LanmanServer、未改防火牆、未綁定非 loopback；TCP 445 繼續由原有 Windows PID 4 listener 持有，未修改。
- **路徑隔離 smoke：** 以 `%TEMP%` synthetic sibling sentinel 建立 alpha share 外部 junction；junction escape、`..` parent traversal 與絕對 drive path 的 SMB read 及 CREATE/write 嘗試均被拒。仍未測 symlink。
- **未測：** 並行 session、byte-range lock／share conflict、斷線重連、拒絕未簽章／未加密 client，以及 Windows 原生 client alternate-port flow。故目前為 **候選有正向 protocol smoke、但產品整合 no-go／待補 gates**；未勾 roadmap、未改 `THIRD_PARTY.md`。

## 下一個實作閘門

在 Windows 11 24H2+ 或 Windows Server 2025+ 重跑原生 alternate-port client flow，再完成路徑／junction 隔離、並行／鎖定、重連與負向簽章／加密測試；任何 gate 失敗都回到 Windows 內建 SMB Server 與其他可維護候選重新比較。任何引擎都須完成逐帳號授權、重新解析點防護、指定 IP 綁定、簽章／加密及正常停機測試，再接入受控生命週期。候選未通過前，不開放 TCP 445、不變更 Windows 內建 SMB 服務或防火牆，也不把候選原始碼列入 `THIRD_PARTY.md`。

## 2026-11-06 Linux 部分驗證與 Windows 缺口

- 範圍：定錨 [`smb-v04-slice-0.md`](smb-v04-slice-0.md)；只在 Linux x86_64 檢查現有唯讀 probe、固定 revision 的候選 README／manifest／example，並執行 Nanako 既有測試。沒有啟動 SMB server 或 listener。
- 固定 revision `c57fe2c1e58f3bb0882b4e762a89522824d16ccd` 的 `Cargo.toml` 標示 `smb-server` 0.8.0、`rust-version = "1.95"`；上游 example 預設 `127.0.0.1:4445`，但包含 public／匿名 shares，不符合 Nanako 驗收，不能取代 private-share harness。上游提供候選程序自身的 `shutdown_handle()` API，和 Windows `LanmanServer` 無關。
- 本機為 Cargo/Rust 1.85.1，無 rustup、Rust 1.95、Windows target／MSVC linker、PowerShell 與 `smbclient`；因此本次**未做 Windows build，也未做 SMB2/3 client 互通**。既有 Windows crate tests 的 CI 通過仍只代表 crate test suite，不能當作本 slice 驗收。
- 既有 `readWindowsSmbStatus` 在 Linux 直接回 `supported: false`／`detected: false`／`serverService: Unsupported`；這是平台防護路徑，不是實際 Windows 服務或 445 狀態。服務／445／命令欄位與 `/api/smb/status` 的 elevation 已存在，故本包不改 probe、不加 route。

### 2026-11-06 執行時待辦（由 2026-11-10 結果更新）

- [x] 固定 revision、Windows x64、Rust 1.95.0、候選 crate tests／build 及 private harness build。
- [x] Private-only 兩帳號／兩 share harness、loopback-only listener、停止後確認 4445 關閉；未操作 `LanmanServer`／445／防火牆。
- [ ] Windows 原生 alternate-port client：此 Windows 10 host 不支援 Microsoft 記載的 client flow；`\\127.0.0.1@4445` 是錯誤連接形式，需在 Windows 11 24H2+／Server 2025+ 重測。
- [ ] 路徑／junction／symlink 隔離、並行／鎖定／重連與拒絕未簽章／未加密 client 尚未測；Impacket 0.13.1 已完成正向 dialect／signing／encryption、CRUD、逐分享授權與匿名拒絕 smoke。
- [x] 已回填 Windows／client/tool versions、結果與目前 no-go；roadmap 保持未勾選，未宣稱採用引擎。
