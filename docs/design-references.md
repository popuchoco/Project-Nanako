# 介面與產品設計參考

本文件記錄產品與介面層面的參考方向，**不是第三方套件清單**。目前只參考公開說明與展示內容，沒有複製或匯入這些專案的原始碼、圖片、圖示、字型或其他資產；因此不列入 `THIRD_PARTY.md`。

## 參考方向

- [Home Server Interface](https://github.com/kittyruntime/home-server-interface)：參考在同一個介面中串起檔案管理、桌面／視窗模式與系統概況的資訊架構。它是面向 Linux 伺服器的產品；Linux 儲存管理、Docker、SMB、系統服務與權限提升機制不直接套用到 Nanako。
- [CasaOS](https://github.com/IceWhaleTech/CasaOS)：參考以易辨識的入口、應用程式捷徑與一覽式狀態呈現個人雲端功能。Nanako 只採用適合單一 Electron 視窗的呈現概念，不採用 CasaOS 的硬體／Linux 部署方式。
- [VaultOS](https://github.com/justwaitfor-me/VaultOS)：僅列為家庭伺服器儀表板與個人儲存產品的概念參考。其公開 README 提到 Auth0 與雲端儲存等方向，但未說明檔案上鎖或靜態加密實作，因此不把它當成加密技術依據；Nanako 的加密空間仍須自行設計與測試。
- [smbwebclient](https://github.com/vmvarela/smbwebclient)：參考以網頁介面管理 SMB 檔案瀏覽、上傳、下載、建立資料夾、刪除與重新命名的操作流程。這是連線至既有 SMB 分享的用戶端，不是 SMB 伺服器；Nanako 已有檔案管理器，不會為了這項參考另外採用 PHP、FrankenPHP 或 `icewind/smb`。
- [Samba-Manager](https://github.com/lyarinet/Samba-Manager)：參考 SMB 管理介面可呈現的分享、使用者／群組權限、服務狀態、操作紀錄、輸入驗證與初始設定流程。該專案管理 Linux Samba；Nanako 是 Windows 專案，不直接套用它的 Samba 設定、Linux 指令或原始碼。

## 檔案去重與空間整理

檔案管理可提供重複檔案掃描與整理流程：先確認固定且受限的掃描範圍，再檢查重複群組與可回收容量，最後由使用者挑選保留檔案及要整理的副本。Nanako 的掃描範圍只能是 `NanakoData`，不得提供選取其他磁碟或任意 Windows 資料夾的入口。不能只以檔名或檔案大小判定重複；規劃以內容雜湊識別相同內容，並在實作前評估大型檔案的串流雜湊、取消、進度與資源使用。整理前需顯示完整清單並要求確認，預設將所選副本移至 Nanako 資源回收桶，而非永久刪除；不得自動挑選或刪除檔案。此為產品功能參考，不代表已實作，也未採用其他專案的程式碼、資產或套件。

SMB 是 Nanako 的必要功能規劃，不會因目前只提供本機服務而刪除或降為可有可無。上述 SMB 專案只作為介面／操作流程參考，目前沒有複製或匯入其程式碼或資產，故不列入 `THIRD_PARTY.md`。Windows SMB 伺服器實作方式、Nanako 帳號認證映射與管理員權限分離，依 [ADR-0015](decisions/ADR-0015-smb-sharing.md) 及 [SMB 實作規劃](smb-implementation-plan.md) 推進。

若日後實際採用任一專案的程式碼或資產，需先確認版本、授權、修改內容與封裝方式，並依規定更新 `THIRD_PARTY.md`。
