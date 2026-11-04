# Project Nanako

**Project Nanako 是一個奠基於 Windows 的類 sandbox 仿 NAS 專案**，以一般 Windows 電腦提供近似 NAS 的純軟體檔案管理與分享體驗，不需專用硬體；本專案是以 **Electron 為基礎的延伸作品**。

**專案描述：**在 Nanako 視窗內模擬桌面操作體驗，並提供隨選隨用、資料範圍受限的本機檔案空間。桌面工作列、捷徑、應用程式選單與可移動／最小化／最大化／關閉的視窗，都是 Nanako 內部介面，不會取代或控制 Windows 桌面與系統功能。本專案程式碼採用 **Mozilla Public License 2.0（MPL-2.0）**，完整條文見 [LICENSE](LICENSE)。

目前原型將管理的檔案與帳號中繼資料存放於應用程式資料目錄，服務僅綁定本機迴圈介面。此處的「sandbox」是專案定位，不代表作業系統層級的安全沙箱，也不表示目前已能取代正式 NAS 或提供區域網路服務。

目前是可執行的早期原型：可在本機建立管理員與使用者、設定 Nanako 資料空間讀寫權限、瀏覽資料夾、匯入／下載檔案、使用資源回收桶、瀏覽圖片及播放瀏覽器支援的音訊／影片。檔案管理範圍嚴格限於可攜式執行檔所在位置的 `NanakoData`；相簿、播放器與資源回收桶也只操作這個範圍，不會瀏覽其他磁碟或 Windows 個人資料夾。Windows x64 可攜式封裝與封裝後的媒體測試模式已建置並啟動驗證；使用者介面完整流程、資料保留與真實來源媒體矩陣仍待測。

## 目前範圍

- Electron 桌面視窗搭配內嵌本機 HTTP 服務；Electron 視窗啟動時使用隨機連接埠。Windows x64 可攜式 `.exe` 已完成建置；封裝後的媒體測試模式可執行並產生報告。正式使用介面流程、關閉重開後資料保留與實際來源影音檔仍待驗證。
- Nanako 視窗內提供仿桌面的操作介面：桌面捷徑、應用程式選單、工作列、時鐘，以及可拖曳、最小化、最大化與關閉的 Nanako 內部應用程式視窗；不呼叫 Windows Shell 或修改作業系統桌面。
- 命令列模式預設使用 `127.0.0.1:8765`；目前**不開放區域網路連線**。
- 首次啟動建立本機管理員；帳號、權限與登入工作階段存放在本機 SQLite。
- 管理員可新增本機使用者，並指定分享資料夾的讀取／寫入權限。
- 支援資料夾瀏覽、建立資料夾、上傳、下載、移至資源回收桶、還原及管理員永久刪除。
- 相簿可瀏覽目前資料夾圖片並開啟全螢幕檢視；播放器支援單一資料夾內的音訊／影片播放清單與 HTTP Range 串流。
- 不含 SSO、雲端帳號、遠端中繼、遙測、更新檢查或硬體控制。
- SMB、區域網路介面選擇及正式外部整合 API 尚未實作，列入後續規劃。
- 加密空間／檔案上鎖尚未實作；目前 NanakoData 中的一般檔案仍可由具有該目錄 Windows 存取權的使用者直接開啟。後續上鎖功能會以實際加密保存為前提，而非只隱藏檔案或調整權限。
- ZIP 壓縮／解壓縮尚未實作；已開始規劃 NanakoData 內的串流 ZIP 操作與安全驗證，尚未新增 ZIP 套件。
- 「我的電腦」只列出使用者有權存取的 Nanako 資料空間，不會列出 Windows 磁碟、已知資料夾或任意路徑。匯入檔案會將使用者選取的檔案複製到 Nanako 資料目錄；其他檔案操作只會存取 Nanako 目錄。
- 「電腦資訊」可查看作業系統、處理器、記憶體、Nanako 資料目錄所在磁碟容量及網路介面資訊，僅供本機管理員查看。
- 播放器提供 Electron 內建 Chromium 的格式能力提示，以及由本機測試片段實際錄製並播放的相容性測試。能力提示不等同所有來源檔均可播放；未能由內建錄製器產生的格式仍需用實際檔案驗證。

本原型不適合直接公開部署或存放重要資料。開放區域網路前，需完成網卡／連接埠設定、TLS 憑證、授權與檔案系統安全測試；發布前也需完成可攜式封裝與第三方授權盤點。

原始碼及 MPL-2.0 授權條文可由 [Project Nanako GitHub 專案](https://github.com/popuchoco/Project-Nanako) 取得。

## 開發環境

- Node.js 22.13 以上（使用內建 `node:sqlite`）
- npm
- Electron 45.2.2（桌面版開發相依套件）

```powershell
npm test
npm run test:media # Electron 執行期格式宣告與可產生測試片段的實際播放檢查
npm run package:win # Windows x64 可攜式封裝，輸出至 dist/
npm start       # 本機網頁原型：127.0.0.1:8765
npm run desktop # Electron 桌面視窗
```

可攜式桌面版將設定檔、工作階段與資料放在可攜式執行檔旁的 `NanakoData\`；請將程式放在目前 Windows 使用者可寫入的位置。Electron 開發啟動時資料位於專案目錄的 `NanakoData\`；命令列模式使用相同專案目錄。不能透過介面指定其他磁碟或外部資料夾。可用 `LOCALNAS_PORT` 更改命令列模式的連接埠；此版本會拒絕非迴圈介面位址，不要用它提供區域網路服務。

測試已封裝桌面程式的媒體相容性：`dist\Nanako-0.2.0-x64-portable.exe --media-compatibility-test`。測試報告會列出 Electron／Chromium 版本、格式能力宣告及可產生測試片段的實際解碼結果。這不會以 FFmpeg 轉碼；媒體格式支援以實際發行檔及來源檔測試結果為準。

## 隱私與資料處理

- 應用程式原始碼不含外部 API、雲端登入、遙測或遠端更新呼叫。
- 原型只綁定本機迴圈介面；不建立防火牆規則，也不設定路由器連接埠轉送。
- 密碼使用 scrypt 雜湊；工作階段權杖以雜湊值存於 SQLite。
- 檔案、相簿、播放器與資源回收桶的實體路徑都由伺服器固定映射至 `NanakoData\data\files` 或 `NanakoData\data\trash`；API 只接受資料空間內的相對路徑，拒絕路徑跳脫與符號連結。匯入是明確複製操作，應用程式不提供外部資料夾瀏覽或管理功能。
- 「不傳送資料到外部」仍須於正式封裝後，透過 Windows 防火牆或封包擷取驗證完整發行檔；目前尚未完成該驗證。

## 文件

- [系統架構](docs/architecture.md)
- [設計說明](docs/design.md)
- [目前本機 API](docs/api.md)
- [Electron 媒體相容性初測](docs/media-compatibility-report.md)
- [版本規劃](docs/roadmap.md)
- [決策紀錄](docs/decisions/)
- [第三方專案與授權](THIRD_PARTY.md)
- [版本紀錄](CHANGELOG.md)
- [台灣用語指南](docs/terminology.md)
- [Mozilla Public License 2.0](LICENSE)
- [介面與產品設計參考（不含採用原始碼）](docs/design-references.md)
- [加密空間與 ZIP 檔案管理規劃（尚未實作）](docs/feature-plan-encryption-and-archives.md)

