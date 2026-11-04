# THIRD_PARTY — 第三方專案、套件與授權

本清單記錄直接相依套件及開發時參考的開源專案。新增或移除相依套件時，請同步更新版本、用途、授權與發行檔包含狀態。正式發行前仍須產生完整相依套件／授權清冊，包含 Electron 隨附的轉相依元件。

## 執行與開發相依套件

| 專案 | 鎖定版本 | 用途 | 授權／來源 | 發行檔狀態 |
| --- | --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 45.2.2 | 桌面視窗、Chromium renderer 與 Node.js 主程序；本專案以 Electron 為基礎的延伸作品 | MIT；請以對應版本的 `LICENSE` 與正式發行套件所附授權檔為準 | `package.json` 已列為開發相依套件；尚未完成封裝，發行時預期會隨桌面程式提供 |
| [Node.js](https://github.com/nodejs/node) | 需 Node.js 22.13 以上；Electron 內含其執行期 | 使用 `node:http`、`node:fs`、`node:sqlite`、`node:crypto` 等內建模組 | Node.js 專案授權採多重授權；以實際發行檔所附授權為準 | 開發測試使用本機 Node.js；Electron 發行檔會含其 Node.js 執行期及相依元件 |

目前沒有其他 npm 執行期套件；UI 使用原生 HTML、CSS 與 JavaScript。`node_modules`／鎖定檔尚未產生，因此正式打包前需產生並審查 npm lockfile、SBOM 與 Electron 相依授權清單。

## 開發參考（非執行相依）

| 專案 | 參考範圍 | 授權資訊 | 是否複製／載入 |
| --- | --- | --- | --- |
| [taiwanizer](https://github.com/Hans-Hanlin/taiwanizer) | 台灣常用詞彙檢視、詞典資料可能有獨立授權的提醒 | 專案程式碼標示 MIT；詞典／第三方資料須依各自授權確認 | 否；僅作人工用語參考，未複製程式碼或字典，未加入執行期 |
| [taiwan-md](https://github.com/frank890417/taiwan-md) | 台灣繁體中文語境與編輯參考 | 專案標示 CC BY-SA 4.0 | 否；僅作參考，未複製文件內容或資料 |

## 維護規則

1. 新增任何套件或外部程式碼前，先記錄專案連結、版本、用途、授權、維護狀態及發行檔是否包含。
2. 不以「開源」推定可任意使用；字典、字型、媒體 codec、圖示、圖片及轉相依套件須分別確認授權。
3. 發行前以 lockfile 與實際封裝結果產出 SBOM／授權聲明；不以本文件取代法律授權檢查。

