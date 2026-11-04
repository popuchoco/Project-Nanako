# ADR-0004：Windows 可攜式 Electron 封裝與媒體相容性驗證

- 狀態：已採用；Windows x64 可攜式封裝與媒體測試模式已驗證，真實來源媒體矩陣待測
- 日期：2026-11-05

## 背景

產品定位是 Windows 上的軟體式本機檔案空間，需要隨選隨用；影音播放能力受 Electron 所含 Chromium、作業系統與實際檔案容器／編碼影響。瀏覽器的格式提示無法證明任意來源檔都能解碼，因此先要能測試桌面封裝執行期與實際媒體。

## 決策

- 以 Electron 作為桌面程式基礎，採 electron-builder Windows x64 `portable` 目標，不要求使用者安裝服務或專用硬體。
- 可攜式執行檔旁建立 `NanakoData/profile`、`NanakoData/session` 與 `NanakoData/data`，便於程式與資料一起攜帶；使用者需將執行檔放在可寫入位置。非可攜式開發啟動仍使用 Electron `userData`。
- 桌面播放器同時呈現 `canPlayType`／MediaCapabilities 宣告，以及從 Nanako 資料空間選取檔案後由目前 Electron 執行環境實際播放的結果。`npm run test:media` 另以 Chromium 產生可用的短測試片段並在同一執行期回放；封裝後以 `--media-compatibility-test` 執行。
- 不因格式宣告不支援就直接加入解碼套件。先保存 Electron／Chromium 版本、來源檔格式與測試結果，確認可重現的需求缺口後才評估 FFmpeg；第一階段優先限於媒體資訊與縮圖，轉檔播放另行評估。
- ZIP 功能尚未納入第一版；確認需求後再評估 JSZip。任何大型檔案讀寫都應使用串流，避免將整個檔案載入記憶體。
- 不直接加入 `dav1d`、`libgav1`、`libvpx`、OpenH264、Opus 或 FLAC 個別解碼器。
- 現階段不另行引入 Skia、WebRTC、NSS、BoringSSL、gRPC 作為應用程式直接依賴。這不代表 Electron／Chromium 的底層發行元件不含這些專案；發行授權盤點仍須涵蓋 Electron 隨附元件。
- 新增直接套件時，先在 `THIRD_PARTY.md` 記錄版本、用途、授權與發行封裝狀態。

## 驗證方式

```powershell
npm test
npm run test:media
npm run package:win
.\dist\Nanako-0.2.0-x64-portable.exe --media-compatibility-test
```

媒體矩陣分別記錄宣告能力與實際測試結果；至少以已匯入 Nanako 資料空間的真實檔案確認常見 H.264/AAC、HEVC、VP9、AV1、MP3、AAC、FLAC 等案例。測試限於 Nanako 資料空間內的指定檔案與目前環境，不能推廣成完整 codec 相容保證。完成封裝後還要確認可攜式資料目錄建立、關閉程式後重開與資料保留。

## 後果

- 優點：先取得實際 Electron 桌面執行期證據，以免在沒有缺口證據前增加套件、發行體積及授權維護成本。
- 限制：`MediaRecorder` 只能為部分格式產生測試素材；能力提示與合成片段不能取代真實使用者影音檔的逐格式播放測試。
- 發行前需檢查完整相依樹、Electron／Chromium 授權檔、Windows Defender 誤判及可攜式目錄寫入權限。
