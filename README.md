# Project Nanako

以 Windows 電腦為主的本機檔案空間原型。Nanako 提供桌面操作介面、本機帳號與檔案權限，也可選擇讓同一私人網路中的其他裝置透過瀏覽器存取檔案。

> **目前版本：`0.3.0-rc.6`（預先發行測試版）**｜[下載 Windows x64 版本](https://github.com/popuchoco/Project-Nanako/releases/tag/v0.3.0-rc.6)｜[檢視版本紀錄](CHANGELOG.md)

Nanako 仍在開發中，並非可直接取代正式 NAS 的產品。特別是 **SMB 檔案分享尚未實作**；目前的 SMB 實驗性開關不會建立分享或啟動 SMB 服務。

## 網路存取方式

### 區域網路網頁存取

管理員可在 Nanako 桌面版的「網路狀態」設定中，選取一張已連線的私人 IPv4 網路介面卡、指定服務連接埠，再啟用 HTTPS 網頁登入。其他裝置登入後，可依使用者權限透過同一套 Nanako 網頁介面瀏覽、上傳及下載檔案。

- 預設關閉，只接受所選網路介面卡所屬子網路內的連線。
- 使用自簽 TLS 憑證；首次連線時，請核對 Nanako 顯示的 SHA-256 憑證指紋。
- Nanako 不會自動修改 Windows 防火牆或路由器設定；需要時請自行允許私人網路連線。
- 這是 **HTTPS 網頁服務**，不是 SMB，也不會在檔案總管中建立網路磁碟機。

### SMB 網路分享

SMB 是另一種網路存取方式，預期用於 Windows 檔案總管的網路分享。目前 Nanako 尚未整合 SMB 伺服器、建立 SMB 分享或啟動 SMB 監聽服務。

設定頁中的「SMB 實驗性功能」目前只會將管理員的啟用選擇寫入設定：預設關閉，且僅 Windows 11 24H2 以上可勾選。**勾選後仍不會啟動 SMB 分享。**

## 功能概覽

- **桌面操作介面**：桌面捷徑、啟動器、工作列、Dock 與可移動、最小化及關閉的應用程式視窗；Windows 桌面與 Shell 不會被取代。
- **本機帳號與權限**：建立本機使用者、設定顯示名稱、管理資料空間讀寫權限、變更密碼及停用帳號。
- **檔案管理**：建立資料夾、上傳、下載、重新命名、移動、複製、批次操作、資源回收筒與還原。
- **相片與媒體**：相簿、音訊／影片播放、媒體搜尋及播放進度續播；可播放格式依 Electron／Chromium 與實際檔案而異。
- **整理工具**：依檔案類型搜尋、排序、重複檔案掃描與 ZIP 壓縮／解壓縮。
- **加密空間原型**：加密檔案、復原金鑰、加密資源回收筒及本機備份／還原。此功能仍是原型，備份不會離開 Nanako 資料目錄。
- **傳輸與網路資訊**：檢視正在進行的上傳／下載及傳輸速率；手動檢查本機網路與 Microsoft Windows NCSI 檢測端點的連線。測試讀取 [`http://www.msftconnecttest.com/connecttest.txt`](http://www.msftconnecttest.com/connecttest.txt)，不是網站首頁；結果只代表此端點可否連線，不保證所有網站都能連線，也不會上傳檔案。
- **Windows 桌面版**：提供 x64 可攜式執行檔及 NSIS 單一使用者安裝程式；不安裝 Windows 服務，安裝時也不需以系統管理員身分執行。

一般檔案與操作均限制在 Nanako 管理的 `NanakoData` 範圍內，不提供瀏覽或管理其他磁碟、Windows 個人資料夾或任意路徑。此限制是應用程式的資料範圍，不是 Windows 作業系統層級的安全沙箱；一般檔案預設不會加密。

## 下載與啟動

前往 [`v0.3.0-rc.6` 發行頁面](https://github.com/popuchoco/Project-Nanako/releases/tag/v0.3.0-rc.6)，選擇適合的 Windows x64 套件：

- **Portable**：免安裝，執行檔與 `NanakoData` 放在同一位置。
- **Setup**：單一使用者安裝程式，資料放在該使用者的應用程式資料目錄。
- **`SHA256SUMS.txt`**：下載後可用來核對安裝檔與可攜式執行檔的 SHA-256 雜湊值。

這是預先發行測試版，建議先使用可復原的測試資料試用。從可攜式版轉到安裝版時，兩者使用不同資料目錄，不會自動搬移資料。

## 從原始碼執行

需求：Windows、Node.js 22.13 以上及 npm。

```powershell
npm ci

# 啟動本機服務與網頁介面（預設 127.0.0.1:8765）
npm start

# 或啟動 Electron 桌面版
npm run desktop
```

首次啟動時，請依畫面建立 Nanako 管理員帳號。命令列模式只接受迴圈介面連線；區域網路 HTTPS 功能僅提供於 Electron 桌面版，且必須由管理員手動開啟。

### 資料位置

| 執行方式 | `NanakoData` 位置 |
| --- | --- |
| Windows 可攜式版 | 執行檔旁的 `NanakoData/` |
| NSIS 使用者安裝版 | 該 Windows 使用者的 Electron `userData/NanakoData/` |
| 開發／命令列模式 | 專案目錄中的 `NanakoData/` |

解除安裝不會主動刪除使用者資料。備份或搬移資料前，請先完整退出 Nanako，並參閱[安裝與資料位置](docs/installation.md)。

## 測試與封裝

```powershell
npm test                         # 全部單元與整合測試
npm run test:desktop-smoke       # Electron 桌面啟動與資料保留測試
npm run test:media               # 檢查 Electron 媒體能力與測試片段
npm run package:win              # 建立 Windows x64 可攜式版
npm run package:win:installer    # 建立 Windows x64 NSIS 安裝版
```

GitHub Actions 會在推送版本標籤後執行測試、Windows 封裝及封裝後驗證。一般版本標籤會建立正式 Release；含 `-rc` 或 `-preview` 等預先發行標記的版本標籤會建立 GitHub 預先發行版。驗證失敗時不會發行套件。

## 已知限制

- 區域網路登入使用自簽憑證，尚未完成不同裝置、網路介面卡與 Windows 防火牆組合的測試；請只在可信任的私人網路使用，不要將連接埠轉送至公開網際網路。
- SMB 分享服務尚未實作；實驗性開關不等於可用的檔案總管分享功能。
- 加密空間仍是原型，尚未完成獨立安全審查、完整故障注入及異地備份流程；同一台裝置或同一資料目錄的備份無法防止裝置遺失。
- 專案目前沒有雲端帳號、遙測或自動更新功能。內部 API 尚非穩定的外部整合介面。

## 專案文件

- [版本規劃與里程碑](docs/roadmap.md)
- [安裝與資料位置](docs/installation.md)
- [系統架構](docs/architecture.md)
- [API 文件](docs/api.md)
- [臺灣繁體中文用語指南](docs/terminology.md)
- [SMB 實作規劃](docs/smb-implementation-plan.md)
- [加密空間與 ZIP 原型](docs/feature-plan-encryption-and-archives.md)
- [版本紀錄](CHANGELOG.md)
- [第三方套件與授權](THIRD_PARTY.md)

## 授權

Project Nanako 以 [Mozilla Public License 2.0（MPL-2.0）](LICENSE) 授權。
