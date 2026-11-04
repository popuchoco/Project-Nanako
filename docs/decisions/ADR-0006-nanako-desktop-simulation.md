# ADR-0006：在 Nanako 視窗內模擬桌面操作體驗

- 狀態：採用
- 日期：2026-11-05

## 背景

產品希望以桌面捷徑、工作列及應用程式視窗呈現類似作業系統桌面的操作體驗，但 Project Nanako 本身仍是一般 Windows 應用程式。

## 決策

- 在 Electron 的 Nanako 視窗內繪製仿桌面 shell；桌布、捷徑、啟動選單、時鐘、工作列與應用程式視窗皆由 Nanako renderer 呈現。
- 內部視窗支援拖曳、最小化、最大化、還原及關閉；關閉內部視窗只回到 Nanako 桌面，不會停止服務或關閉外層 Electron 視窗。
- 應用程式只會呼叫自身本機 API，不操作 Windows Shell、工作列、登錄檔、系統桌布或其他 Windows 桌面設定。
- 桌面捷徑只連到 Nanako 內建功能，不提供磁碟或外部資料夾捷徑。
- 視覺與資訊架構可參考 Home Server Interface、CasaOS 等公開展示；不因此複製其程式碼或資產。設計參考與實際第三方元件分開紀錄。

## 理由

在 Nanako 視窗內模擬即可滿足一致的產品操作感，同時維持可攜式程式邊界與既有儲存範圍限制，避免把原型誤認為作業系統或虛擬機。

## 影響

- 桌面互動邏輯與視覺效果由 `public/index.html`、`public/styles.css`、`public/app.js` 管理。
- 後續新增的捷徑、視窗或選單項目仍須服從 Nanako 權限檢查及 `NanakoData` 儲存限制。
- 響應式版面與鍵盤可及性需持續驗證；此模擬介面不提供 Windows 原生桌面整合。
