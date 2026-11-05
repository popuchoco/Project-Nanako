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
- 尚不能視為通過：本次環境沒有 Rust toolchain，未執行 `cargo test`、Windows 編譯、SMB 用戶端互通、IP 綁定或停止服務測試；文件列出的限制包括 Kerberos、oplocks／directory leases、DFS、alternate data streams、reparse points 等。
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
- 現有 HTTP 檔案 API 已改用共用權限判斷，避免未來 SMB Adapter 自行複製並偏離 Nanako 權限語意。
- 新增單元測試涵蓋管理員、停用帳號、唯讀帳號、未授權帳號、未知操作與非 Nanako 資料根目錄。
- 這是 SMB 的授權政策前置，不是 SMB 協定服務；目前仍不能從其他裝置連線或宣稱 SMB 已實作。

## 下一個實作閘門

優先以 `paltaio/rust-smb-server` 0.8.0 完成 Windows 編譯與 localhost POC；若 Windows 支援、授權介面或用戶端互通任一閘門失敗，回到 Windows 內建 SMB Server 與其他可維護候選重新比較。任何引擎都須完成逐帳號授權、重新解析點防護、指定 IP 綁定、簽章／加密及正常停機測試，再接入受控生命週期。候選未通過前，不開放 TCP 445、不變更 Windows 內建 SMB 服務或防火牆，也不把候選原始碼列入 `THIRD_PARTY.md`。
