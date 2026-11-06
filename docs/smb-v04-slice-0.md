# SMB v0.4 slice-0：Windows localhost 候選驗證

- 日期：2026-11-06
- 對象：`paltaio/rust-smb-server` 0.8.0，tag `v0.8.0`／revision `c57fe2c1e58f3bb0882b4e762a89522824d16ccd`
- 狀態：**已界定驗收方式，尚未完成 Windows 互通驗證，未採用候選引擎**。

本 slice 只交付一個獨立於 Nanako 產品程式的候選測試 harness、Windows 執行結果與 go/no-go 結論。它以兩個 synthetic NanakoData-style 測試根目錄與兩個 synthetic 使用者驗證協定能力，不建立 Windows SMB 分享。

## 下一可實作切片與成功定義

1. 固定上述 revision，在 Windows x64、Rust 1.95.0 執行 `cargo test --workspace`，再建置測試 harness。crate tests 通過不等於用戶端互通通過。
2. harness 只綁定 `127.0.0.1:4445`，不啟用 discovery。以實際 listener 位址證明沒有綁到 LAN；不得為此停止 `LanmanServer`、占用 445 或改防火牆。
3. 只設兩個 private shares，不沿用上游 example 的匿名／public shares：`alpha` 對 `alice` 可讀寫、對 `bob` 唯讀；`beta` 只對 `alice` 開放。未列使用者與匿名／guest 操作一律失敗。
4. 以 Windows 原生 SMB client 連到替代連接埠；命令 `net use \\127.0.0.1@4445\alpha ...` 的語法與可用性必須實測，不能因 File Explorer 不支援替代埠就略過。若 Windows client 不支援，此 slice 為 **no-go／退回候選比較**，不以 macOS／Linux 結果替代。
5. 由協定安全事件／除錯證據記錄每條連線實際交涉的 SMB 2.0.2–3.1.1 dialect、signing、encryption，而非摘錄 API 文件當成實測。至少驗證受控 require-signing 與 SMB3 require-encryption 個案；拒絕不符合要求的匿名／guest。
6. `alice` 在 `alpha` 完成列列舉、讀、寫、建目錄、改名與刪除；`bob` 寫入被拒；`alice` 可連 `beta`，`bob` 不可連。未知 share、其他使用者的路徑與匿名存取不得因猜中名字而通過。
7. `..`、絕對路徑、junction／symlink 指向根目錄外的 sentinel 均不可讀寫；根目錄外的 sibling 建立同名項目以辨識洩漏。另測兩個並行 session、byte-range lock／share conflict、中斷後重連，保存實際結果。
8. 以候選自己的 `shutdown_handle().shutdown()` 正常停止，等 `serve()` 返回及所有 handle 關閉；確認 `127.0.0.1:4445` 不再監聽、既有 session 無法續用。只停止候選測試程序，不操作 Windows 服務。

全部 1–8 有原始 log 且符合結果才算成功，才可另開「Nanako 授權／憑證整合設計」；任何安全、隔離或 Windows 互通閘門失敗即停止，不補產品 adapter 掩蓋問題。跨小時／跨執行的性能、macOS Finder 與 Linux `smbclient` 是候選通過本 slice 後的後續項目。

## Windows 執行方式

在隔離的測試 checkout（**不是產品依賴**）：

```powershell
git clone --branch v0.8.0 https://github.com/paltaio/rust-smb-server.git $env:TEMP\rust-smb-server-0.8.0
git -C $env:TEMP\rust-smb-server-0.8.0 rev-parse HEAD
# 必須輸出 c57fe2c1e58f3bb0882b4e762a89522824d16ccd
rustup default 1.95.0
cargo test --workspace --manifest-path $env:TEMP\rust-smb-server-0.8.0\Cargo.toml
cargo build -p minimal-smb-example --manifest-path $env:TEMP\rust-smb-server-0.8.0\Cargo.toml
```

上游 `minimal-smb-example` 可作 build／正常 Ctrl+C 停止 smoke test，其預設 listener 為 `127.0.0.1:4445`；但它有 public／匿名 shares，**不可當作授權驗收 harness**。授權驗收需另建上述 private-share harness（例如明確 `.require_signing(true)`、SMB3 `.encrypt_data(true)`，並保持 `.reject_unencrypted_access(true)`）及 dialect／security 證據；這些是已檢查的 API 選項，尚非 Windows 實測；不得把 harness 產生或載入的密碼寫入 repo／log。若 smoke test 使用上游隨機密碼，原輸出會記錄密碼，僅可留在本次測試主機，交付前遮除或直接删除，不使用真實帳號／密碼。

執行 harness 時以新 console session 的臨時環境輸入一次性 synthetic secret，完成即關閉；設定 `SMB_LISTEN=127.0.0.1:4445`、`SMB_ROOT` 指向 synthetic 測試目錄，且不要設定 `SMB_DISCOVERY`。用 `Get-NetTCPConnection -LocalPort 4445 -State Listen` 保存位址。下方 Windows client 命令是**待驗證測試步驟**，其中的 secret 由當次測試者互動輸入，不貼進命令／腳本／紀錄：

```powershell
net use \\127.0.0.1@4445\alpha /user:alice *
# alice：dir / type / copy / mkdir / ren / del；然後中斷、重連
net use \\127.0.0.1@4445\alpha /delete
net use \\127.0.0.1@4445\alpha /user:bob *
# bob：讀取應成功，copy / mkdir / ren / del 應拒絕
net use \\127.0.0.1@4445\alpha /delete
# beta 對 bob 必須 TREE_CONNECT 失敗；其餘帳號與匿名也必須失敗
```

每次連線使用獨立 session，避免 Windows 為相同 server 重用另一身分而產生誤判。收集 client 的實際錯誤碼、harness 的協定 security 證據及 listener 前後結果；log 不包含 secret。

## 與 ADR-0013 的順序

- **本 slice 前置：** 無權限提升、無安裝服務、無產品 listener，所以不能解決或勾完 ADR-0013。
- **本 slice 之後：** 先決定候選 go/no-go，再完成 Nanako 使用者／獨立 SMB 憑證設定、撤銷與 secret storage 設計。不得把 Nanako scrypt verifier 還原成明文或保存明文 SMB password。
- **產品整合之前：** 依 ADR-0013 完成受控管理員代理／服務的固定命令、caller／Windows 身分授權、受 ACL 保護 IPC、一般帳號執行及 NanakoData ACL／生命週期驗收。ADR-0013 未完成時，不得把 harness listener 提升為 Nanako 產品服務。
- **最後才做：** 受控啟停、指定網卡與 LAN 驗收、防火牆生命周期、跨平台互通及正式採用／THIRD_PARTY 記錄。

## 明確不做

不建立 Windows share；不啟停 `LanmanServer` 或其他服務；不改防火牆；不開 LAN／non-loopback listener／discovery；不實作 Nanako SMB 產品寫入或管理 API；不新增 runtime dependency；不記錄真實 credentials；不選用引擎；不改 mem+shell backlog。
