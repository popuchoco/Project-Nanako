# SMB v0.4 slice-0：Windows localhost 候選驗證

- 日期：2026-11-06
- 對象：`paltaio/rust-smb-server` 0.8.0，tag `v0.8.0`／revision `c57fe2c1e58f3bb0882b4e762a89522824d16ccd`
- 狀態：**Windows build 與 Impacket SMB 3.1.1 smoke test 已通過；Windows 原生 client、路徑隔離、鎖定／並行等驗收仍未完成，候選未採用**。

本 slice 只交付一個獨立於 Nanako 產品程式的候選測試 harness、Windows 執行結果與 go/no-go 結論。它以兩個 synthetic NanakoData-style 測試根目錄與兩個 synthetic 使用者驗證協定能力，不建立 Windows SMB 分享。

## 下一可實作切片與成功定義

1. **完成：** 固定 revision 於 Windows x64 以 TEMP 內 Rust 1.95.0 執行 `cargo test --workspace`，並建置上游 example 與本 harness。crate tests 通過不等於用戶端互通通過。
2. **完成：** harness 綁定 `127.0.0.1:4445`，不啟用 discovery；實測 listener 僅為 loopback，Ctrl+C 觸發候選 shutdown API 後 listener 消失。未停止 `LanmanServer`、占用 445 或改防火牆。
3. **完成：** 兩個 private shares：`alpha` 對 `alice` 可讀寫、對 `bob` 唯讀；`beta` 只對 `alice` 開放。無 public／guest share。
4. **待完成：** 本機 Windows 10 22H2（build 19045）沒有 Microsoft 文件所述替代連接埠 SMB client 選項；試用 `\\127.0.0.1@4445\alpha` 收到 error 53，server 看到非 Direct-TCP 格式，不是可用語法。Microsoft 文件列出的 `New-SmbMapping -TcpPort`／`NET USE /TCPPORT` client 流程需 Windows 11 24H2+ 或 Windows Server 2025+；因此 Windows 原生互通 gate 仍未通過。Impacket 測試只是補充協定 smoke，不取代此 gate。
5. **部分完成：** Impacket 0.13.1 實測 SMB 3.1.1、session signing 啟用、加密 session flag 啟用；guest／匿名登入失敗。尚未完成拒絕未簽章／未加密用戶端的負向測試。
6. **完成（Impacket）：** `alice` 在 `alpha` 成功列舉、讀、寫、建目錄、改名與刪除，並可連 `beta`；`bob` 可讀 `alpha`，建立／寫入被拒且 `beta` TREE_CONNECT 被拒；匿名登入被拒。`tools/smb-poc/impacket_smoke.py` 可重跑此測試。Impacket `storeFile` helper 僅請求 `FILE_WRITE_DATA`，不適合驗證 EOF 擴展；smoke 腳本使用 `FILE_WRITE_DATA | FILE_APPEND_DATA`。
7. **部分完成：** Windows synthetic sibling sentinel 的 junction escape、`..` parent traversal 與絕對 drive path 均在 SMB read 與 CREATE/write 嘗試中被拒。仍未測 symlink、並行 session、byte-range lock／share conflict、中斷後重連。
8. **部分完成：** Ctrl+C 經候選 `shutdown_handle()` 停止服務，`serve()` 返回且 TCP 4445 不再監聽；尚未測既有連線關閉後重連行為。

全部 1–8 有原始 log 且符合結果才算成功，才可另開「Nanako 授權／憑證整合設計」。目前協定 smoke 測試已提供候選的正向證據，但 Windows 原生 client 與隔離／併發 gates 未完成，因此仍 **no-go for product integration**；不補產品 adapter 掩蓋問題。跨小時／跨執行的性能、macOS Finder 與 Linux `smbclient` 是候選通過本 slice 後的後續項目。

## Windows 執行方式

在隔離的測試 checkout（**不是產品依賴**）使用 Rust 1.95.0。驗證期間將 rustup／Cargo 與 LLVM MinGW 僅放在 `%TEMP%`，PATH 與 LIBRARY_PATH 只對建置程序有效；未修改使用者／系統 PATH 或全域安裝。若已有 Rust toolchain：

```powershell
git clone --branch v0.8.0 https://github.com/paltaio/rust-smb-server.git $env:TEMP\rust-smb-server-0.8.0
git -C $env:TEMP\rust-smb-server-0.8.0 rev-parse HEAD
# 必須輸出 c57fe2c1e58f3bb0882b4e762a89522824d16ccd
cargo +1.95.0 test --workspace --manifest-path $env:TEMP\rust-smb-server-0.8.0\Cargo.toml
cargo +1.95.0 build -p minimal-smb-example --manifest-path $env:TEMP\rust-smb-server-0.8.0\Cargo.toml
```

上游 `minimal-smb-example` 可作 build smoke test，但它有 public／匿名 shares，**不可當作授權驗收 harness**。本 repo 的 private harness 固定 bind `127.0.0.1:4445`，要求 signing／SMB3 encryption，且會拒絕未加密 access；請使用 `%TEMP%` synthetic 資料與一次性帳號。已通過的 Impacket smoke client 腳本是 `tools/smb-poc/impacket_smoke.py`，不屬產品 runtime。

執行 repo harness 時以新 console session 的臨時環境輸入一次性 synthetic secret，完成即關閉；`SMB_POC_ROOT` 指向 synthetic 測試目錄。用 `Get-NetTCPConnection -LocalPort 4445 -State Listen` 保存位址。Windows 原生 client 替代埠測試待在支援的 OS 版本上執行：Microsoft 文件所列 syntax 為 `New-SmbMapping -TcpPort` 或 `NET USE /TCPPORT`，不是 `\\server@port\share`。不得把密碼貼進命令或紀錄。

```powershell
$credential = Get-Credential -UserName 'alice' -Message 'Synthetic SMB POC account'
New-SmbMapping -LocalPath 'Z:' -RemotePath '\\127.0.0.1\alpha' -TcpPort 4445 -Credential $credential
# 驗證完成後移除 mapping。
Remove-SmbMapping -LocalPath 'Z:' -Force
```

在支援 OS 上需以系統管理員權限執行上述 alternate-port mapping；Windows 10 22H2 無法使用此流程，須改在 Windows 11 24H2+ 或 Windows Server 2025+ 重跑。每次連線使用獨立 session，避免 Windows 為相同 server 重用另一身分而產生誤判。收集 client 的實際錯誤碼、harness 的協定 security 證據及 listener 前後結果；log 不包含 secret。詳細 Microsoft 支援版本與命令：[Configure alternative SMB ports](https://learn.microsoft.com/en-us/windows-server/storage/file-server/smb-ports)。

## 與 ADR-0013 的順序

- **本 slice 前置：** 無權限提升、無安裝服務、無產品 listener，所以不能解決或勾完 ADR-0013。
- **本 slice 之後：** 先決定候選 go/no-go，再完成 Nanako 使用者／獨立 SMB 憑證設定、撤銷與 secret storage 設計。不得把 Nanako scrypt verifier 還原成明文或保存明文 SMB password。
- **產品整合之前：** 依 ADR-0013 完成受控管理員代理／服務的固定命令、caller／Windows 身分授權、受 ACL 保護 IPC、一般帳號執行及 NanakoData ACL／生命週期驗收。ADR-0013 未完成時，不得把 harness listener 提升為 Nanako 產品服務。
- **最後才做：** 受控啟停、指定網卡與 LAN 驗收、防火牆生命周期、跨平台互通及正式採用／THIRD_PARTY 記錄。

## 明確不做

不建立 Windows share；不啟停 `LanmanServer` 或其他服務；不改防火牆；不開 LAN／non-loopback listener／discovery；不實作 Nanako SMB 產品寫入或管理 API；不新增 runtime dependency；不記錄真實 credentials；不選用引擎；不改 mem+shell backlog。
