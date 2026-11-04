# 本機 API（原型）

> 目前 API 是隨程式提供的內部本機介面，不是穩定的外部整合 API。僅綁定迴圈介面，尚無 API Token、版本相容承諾或區域網路存取。端點異動時請同步更新此文件與測試。

## 共通規則

- Base URL：`http://127.0.0.1:<port>`。Electron 模式使用隨機連接埠；命令列模式預設 `8765`。
- JSON 請求使用 `Content-Type: application/json`；檔案上傳為原始 request body。
- 登入後使用伺服器簽發的 `HttpOnly` Cookie。瀏覽器介面會自動帶入 Cookie；目前不支援 API Token 或跨來源整合。
- 一般錯誤格式：`{"error":"錯誤代碼","message":"繁體中文說明"}`。
- 需要登入的 API 未提供有效工作階段時回傳 `401`；權限不足回傳 `403`。

## 目前端點

| 方法與路徑 | 登入 | 權限／用途 |
| --- | --- | --- |
| `GET /api/setup-state` | 否 | 查詢是否需要首次設定。 |
| `POST /api/setup` | 否（僅首次） | `{ "username", "password" }`；建立本機管理員與預設分享資料夾，回傳管理員資料並設定工作階段 Cookie。 |
| `POST /api/login` | 否 | `{ "username", "password" }`；登入並設定工作階段 Cookie。 |
| `POST /api/logout` | 否 | 撤銷目前 Cookie 對應工作階段。 |
| `GET /api/me` | 是 | 回傳目前使用者。 |
| `GET /api/shares` | 是 | 列出目前使用者可讀取的分享資料夾與寫入權限。 |
| `GET /api/files?shareId=…&path=…` | 是 | 需有該分享資料夾讀取權限；列出路徑下項目與 `canWrite`。 |
| `POST /api/folders` | 是 | 需有寫入權限；JSON `{ "shareId", "path", "name" }`。 |
| `POST /api/upload?shareId=…&path=…&name=…` | 是 | 需有寫入權限；request body 為檔案內容，單檔上限 5 GiB。 |
| `GET /api/preview?shareId=…&path=…` | 是 | 需有讀取權限；提供允許清單中的圖片／音訊／影片 MIME，支援單一 `Range: bytes=start-end` 請求（回傳 `206`）。 |
| `GET /api/download?shareId=…&path=…` | 是 | 需有讀取權限；回傳檔案內容。 |
| `DELETE /api/files?shareId=…&path=…` | 是 | 需有寫入權限；將項目移至資源回收桶，不能刪除分享根目錄。 |
| `GET /api/trash?shareId=…` | 是 | 需有該分享資料夾寫入權限；列出待還原項目。 |
| `POST /api/trash/restore` | 是 | 需有該項目分享資料夾寫入權限；JSON `{ "id" }`。 |
| `DELETE /api/trash?id=…` | 是 | 僅管理員可永久刪除資源回收桶項目。 |
| `GET /api/users` | 是 | 僅管理員可列出使用者。 |
| `POST /api/users` | 是 | 僅管理員；JSON `{ "username", "password", "permissions": [{ "shareId", "canRead", "canWrite" }] }`。 |
| `GET /api/network` | 是 | 回報目前本機服務資訊與網路介面清單；不會啟用區域網路連線或改變網路設定。 |
| `GET /api/system` | 是 | 僅管理員；查看本機電腦名稱、Windows 版本／組建、處理器、記憶體、Nanako 資料磁碟容量及網路介面資訊。 |

`path` 是分享資料夾內的相對路徑；不可使用絕對路徑或跳脫路徑。名稱須符合 Windows 檔名限制。實際狀態碼與回應內容以 `src/server.mjs` 和 `test/server.test.mjs` 為準。

檔案 API 的根目錄固定為可攜式執行檔所在位置的 `NanakoData/data/files/<shareId>`；API 不接受外部路徑、磁碟代號或資料夾選擇請求。`/api/download` 只傳回該根目錄內的檔案；`DELETE /api/files` 與資源回收桶只操作 `NanakoData/data/trash`。相簿和播放器也只能讀取這些 Nanako 資料空間。Renderer 送入的 `path` 一律是分享資料空間內的相對路徑；伺服器會拒絕資料目錄中的符號連結／重新解析點。

`/api/preview` 目前只處理單一 byte range；不支援多段 range、縮圖或轉碼。音訊／影片能否播放取決於 Electron 內建 Chromium 支援的容器與編碼格式。播放器的相容性測試只能選取目前 Nanako 分享資料空間的檔案，並透過同一個受權限檢查的 Range API 串流播放；不會開啟檔案系統選擇器或讀取外部媒體路徑。

## 外部整合 API 的後續設計

正式開放前需建立 `/api/v1` 版本路徑、OpenAPI 規格、可撤銷的 API Token（scope 與到期日）、每個檔案操作的授權矩陣、速率／大小限制、稽核紀錄、TLS 與 Windows 防火牆設定流程。API Token 應由本機使用者建立，預設不授予管理員權限；撤銷後立即失效。區域網路服務需由使用者主動開啟並可隨時關閉。

