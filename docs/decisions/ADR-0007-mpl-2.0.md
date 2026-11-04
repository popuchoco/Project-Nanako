# ADR-0007：Project Nanako 採用 MPL-2.0

- 狀態：採用
- 日期：2026-11-05

## 背景

專案需要明確的開源授權，並於原始碼與發行文件中保持一致。

## 決策

- Project Nanako 自有程式碼採用 Mozilla Public License 2.0（SPDX：`MPL-2.0`）。
- 專案根目錄提供 Mozilla 發布的完整授權條文 `LICENSE`，套件中繼資料及 README 同步標示授權與專案描述。
- Electron 及其他第三方元件仍依各自授權條款提供；採用 MPL 不會改變第三方授權。

## 影響

- 發行可執行檔時，需同時提供對應的 MPL 涵蓋原始碼與授權資訊。
- 每次增加相依套件時，必須同步更新 `THIRD_PARTY.md` 並檢查其授權與封裝方式。
