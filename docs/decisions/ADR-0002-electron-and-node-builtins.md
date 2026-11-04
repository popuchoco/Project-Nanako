# ADR-0002：以 Electron 為桌面容器並優先使用 Node.js 內建模組

- 狀態：已採用
- 日期：2026-11-04

## 背景

目標平台是 Windows 桌面，需提供圖形介面與本機檔案服務；也希望控制執行期相依套件數量，方便盤點授權與資料流。

## 決策

- 以 Electron 作為桌面視窗與打包基礎，將本機 HTTP 服務放在 Electron 主程序同一應用程式內。
- 目前服務、HTTP 與 SQLite 使用 Node.js 內建模組；直接執行期 npm 相依套件只增加 Electron。
- Electron renderer 停用 Node 整合，使用 context isolation 與 sandbox，不載入遠端內容。
- 保留 `src/run.mjs` 作為不依賴 Electron 的本機測試／開發入口。

## 後果

- 優點：桌面 UI 與本機服務可一起啟停，不必先安裝獨立服務或額外硬體。
- 代價：Electron 發行檔體積較大；升級 Electron 時需重新執行相容性與封裝檢查。
- 風險：目前尚未完成可攜式封裝、安全更新策略或發行檔流量驗證。
- 後續：每次新增 npm 套件需記錄在 `THIRD_PARTY.md`，包含用途、版本、授權與是否包含於發行檔。

