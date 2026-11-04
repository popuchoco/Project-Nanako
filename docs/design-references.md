# 介面與產品設計參考

本文件記錄產品與介面層面的參考方向，**不是第三方套件清單**。目前只參考公開說明與展示內容，沒有複製或匯入這些專案的原始碼、圖片、圖示、字型或其他資產；因此不列入 `THIRD_PARTY.md`。

## 參考方向

- [Home Server Interface](https://github.com/kittyruntime/home-server-interface)：參考在同一個介面中串起檔案管理、桌面／視窗模式與系統概況的資訊架構。它是面向 Linux 伺服器的產品；Linux 儲存管理、Docker、SMB、系統服務與權限提升機制不直接套用到 Nanako。
- [CasaOS](https://github.com/IceWhaleTech/CasaOS)：參考以易辨識的入口、應用程式捷徑與一覽式狀態呈現個人雲端功能。Nanako 只採用適合單一 Electron 視窗的呈現概念，不採用 CasaOS 的硬體／Linux 部署方式。
- [VaultOS](https://github.com/justwaitfor-me/VaultOS)：僅列為家庭伺服器儀表板與個人儲存產品的概念參考。其公開 README 提到 Auth0 與雲端儲存等方向，但未說明檔案上鎖或靜態加密實作，因此不把它當成加密技術依據；Nanako 的加密空間仍須自行設計與測試。

若日後實際採用任一專案的程式碼或資產，需先確認版本、授權、修改內容與封裝方式，並依規定更新 `THIRD_PARTY.md`。
