# Project Nanako

Windows 優先的本機檔案空間原型，以 Electron 提供受限檔案管理、本機帳號權限、媒體播放、ZIP、加密空間、傳輸任務監看與網路診斷。

> **目前狀態**：0.3.0-rc.4 為預發行版，提供預設關閉的區域網路 HTTPS 網頁登入原型及 Windows 11 24H2+ 限定的 SMB 實驗性開關。LAN 跨裝置與防火牆環境仍待實際驗收；SMB 檔案總管分享尚未實作，開關不會啟動 SMB 服務。這是實驗性原型，不是可直接取代正式 NAS 的產品，也不是經獨立安全審查的保險箱。

## Project Nanako 是什麼？

Project Nanako 在一般 Windows 電腦上提供一個本機優先、類 NAS 的檔案空間，不需要專用 NAS 硬體。Electron 桌面程式內含本機 HTTP 服務，並以 Nanako 自己的桌面、工作列與多視窗介面管理檔案、相片及影音；管理員也可選擇啟用私人子網路內的 HTTPS 網頁登入，讓其他裝置透過瀏覽器登入後使用 Nanako 網頁介面上傳、下載及管理授權檔案。這是網頁檔案傳輸，與 SMB 分享是不同功能。

「sandbox」描述的是應用程式的資料範圍：一般檔案操作固定在 Nanako 的 `NanakoData`，不會瀏覽或管理其他磁碟、Windows 個人資料夾或任意路徑。它**不是 Windows 作業系統層級的安全沙箱**；具備 Windows 檔案系統存取權的人仍可能直接存取未放入加密空間的一般檔案。

## 目前已實作

- **Nanako 桌面**：桌面捷徑、啟動器、工作列／Dock、時鐘與內部應用程式視窗。視窗可拖曳、移動、最小化、最大化／還原及關閉；Windows 桌面與 Shell 不會被接管。Windows 桌面版提供系統匣，關閉主視窗會隱藏程式，從系統匣退出才停止服務。
- **本機帳號與權限**：首次設定管理員、建立使用者、指定資料空間讀寫權限、停用／啟用帳號、變更密碼與登入節流。帳號與工作階段存在本機 SQLite；密碼使用 scrypt 雜湊。
- **檔案管理**：資料夾瀏覽與建立、上傳／下載、重新命名、移動、複製、批次操作、資源回收桶與還原。操作限於 Nanako 資料空間，並檢查讀寫權限。
- **搜尋與整理**：依圖片、影片、音訊、文件分類搜尋 Nanako 資料空間；支援檔名篩選、排序及重複檔案掃描／可復原整理。掃描有數量上限，不會搜尋 Windows 其他磁碟。
- **相簿與播放器**：可在資料夾瀏覽或資料空間媒體索引間切換；播放器使用受權限保護的 HTTP Range 串流，播放進度保存在本機並可續播。格式相容性仍取決於 Electron／Chromium 與實際媒體檔。
- **ZIP 與加密空間原型**：NanakoData 內的串流壓縮／解壓縮與 ZIP 路徑、CRC 等檢查；加密空間支援加密檔案、復原金鑰、加密資源回收筒，以及同一 NanakoData 內的加密備份／還原。
- **管理與記錄**：管理員可查看電腦資訊、Windows SMB 前置狀態及本機操作紀錄，並設定紀錄保留期限。
- **SMB 實驗性旗標**：僅 Windows 11 24H2 以上可勾選啟用；較舊版本及非 Windows 一律預設關閉並鎖定。旗標只保存啟用意願，不代表 SMB 伺服器已整合或正在監聽。
- **Windows 發行方式**：提供 x64 可攜式執行檔與 NSIS 單一使用者安裝程式。安裝不要求系統管理員提升，也不會安裝 Windows 服務或修改系統分享設定。
- **區域網路 HTTPS 網頁存取（預設關閉）**：管理員可選擇一張私有 IPv4 網卡與 1024–65535 連接埠，其他裝置可透過瀏覽器登入 Nanako 網頁介面，依權限上傳、下載及管理檔案；TLS 私鑰由 Windows DPAPI 保護，連線限制在選定網卡的子網路。這不是 SMB 網路磁碟機服務；不會自動建立防火牆規則或路由器轉送。

## 範圍與限制

- Electron 桌面版可選擇性啟用私人子網路 HTTPS 網頁登入；命令列模式仍只綁定迴圈介面（預設 `127.0.0.1:8765`）。
- LAN 網頁存取使用自簽憑證；其他裝置首次連線會顯示憑證提示，需比對 Nanako 顯示的 SHA-256 指紋。Windows 防火牆需由使用者自行允許私人網路連線；不可將連接埠轉送到公開網際網路。跨裝置及防火牆環境尚待驗收。網頁上傳／下載透過 HTTPS 網頁服務，不依賴 SMB。
- 網頁登入與 SMB 是不同功能。Nanako SMB Server、檔案總管分享及跨平台互通仍未實作；即使符合版本條件並開啟實驗性旗標，也不會啟動 listener、建立 Windows 分享或修改防火牆。
- 加密空間仍是本機原型，尚未完成獨立安全審查、完整磁碟故障注入與異地備份流程。備份目前仍在同一個 `NanakoData`，不能防止裝置或整個資料目錄遺失，也不承諾 SSD 安全抹除。
- 原始碼目前不包含雲端登入、遙測或遠端更新功能；完整發行封裝的外部網路流量尚未完成封包層驗證。
- 不建議用於公開部署或存放唯一的重要資料。發行前仍需持續完成安全、相容性、升級與復原驗證。

## 快速開始

需求：Windows、Node.js 22.13 以上與 npm。

```powershell
npm install

# 本機網頁原型（127.0.0.1:8765）
npm start

# 或啟動 Electron 桌面程式
npm run desktop
```

程式首次啟動時建立本機管理員帳號。桌面版預設只供本機使用；管理員可在「網路狀態」明確啟用區域網路登入。命令列模式可用 `LOCALNAS_PORT` 更改本機連接埠，但仍只接受迴圈介面位址。

### 資料位置

| 模式 | NanakoData 位置 |
| --- | --- |
| 可攜式 Windows 執行檔 | 執行檔旁的 `NanakoData/` |
| NSIS 使用者安裝版 | 該 Windows 使用者的 Electron `userData/NanakoData/` |
| 開發／命令列模式 | 專案目錄中的 `NanakoData/` |

以上模式使用不同資料目錄，不會自動互相搬移。解除安裝不會主動刪除使用者資料。從可攜式版轉移至安裝版前，請先完整退出程式並備份；詳細步驟見[安裝與資料位置](docs/installation.md)。

## 測試與封裝

```powershell
npm test                         # 單元與整合測試
npm run test:desktop-smoke       # Windows Electron 首次設定、操作與重啟資料保留
npm run test:media               # Electron 執行期媒體能力與可產生測試片段檢查
npm run package:win              # Windows x64 可攜式版，輸出至 dist/
npm run package:win:installer    # Windows x64 NSIS 使用者安裝版，輸出至 dist/
```

媒體測試報告反映 Electron 內建 Chromium 的能力及測試片段結果，不代表所有來源檔格式都能播放。封裝後亦可執行 `Nanako-0.3.0-x64-portable.exe --media-compatibility-test` 產生媒體相容性報告。

## GitHub Actions 自动发布

版本标签会触发 [Windows release workflow](.github/workflows/release.yml)。推送标签前，先让 package.json 与 package-lock.json 的版本号同步为该版本并提交；workflow 会检查标签与两处版本一致，再运行测试、建置及封装后 smoke tests。

- 普通版本标签（例如 v0.3.0）会建立正式 Release。
- 带 SemVer 预发布后缀的标签（例如 v0.4.0-rc.1 或 v0.4.0-preview.1）会建立 GitHub Pre-release。
- Release 会附上 Windows x64 可携式版、NSIS 安装版与 SHA256SUMS.txt。任何验证失败时都不会发布。

## 文件

- [版本規劃與各里程碑狀態](docs/roadmap.md)
- [安裝與資料位置](docs/installation.md)
- [系統架構](docs/architecture.md)
- [目前本機 API](docs/api.md)
- [Electron 媒體相容性初測](docs/media-compatibility-report.md)
- [SMB 區域網路分享規劃](docs/smb-implementation-plan.md)
- [加密空間與 ZIP 原型／驗證](docs/feature-plan-encryption-and-archives.md)
- [版本紀錄](CHANGELOG.md)
- [第三方專案與授權](THIRD_PARTY.md)
- [Mozilla Public License 2.0](LICENSE)

---
Project Nanako 以 [MPL-2.0](LICENSE) 授權。原始碼：[GitHub](https://github.com/popuchoco/Project-Nanako)。
