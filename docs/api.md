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
| `POST /api/password` | 是 | `{ "currentPassword", "newPassword" }`；修改自己的密碼、撤銷其他工作階段並更新目前 Cookie。 |
| `POST /api/logout` | 否 | 撤銷目前 Cookie 對應工作階段。 |
| `GET /api/me` | 是 | 回傳目前使用者。 |
| `GET /api/shares` | 是 | 列出目前使用者可讀取的分享資料夾與寫入權限。 |
| `GET /api/files?shareId=…&path=…` | 是 | 需有該分享資料夾讀取權限；列出路徑下項目與 `canWrite`。 |
| `GET /api/files/search?shareId=…&category=image\|video\|audio\|document\|media&search=…` | 是 | 需有該 Nanako 資料空間讀取權限；在所選資料空間內遞迴搜尋分類檔案，其中 `media` 同時包含音訊與影片，可用檔名片段篩選（最多 180 字元）。不跨分享資料空間、不包含資源回收桶或內部暫存目錄；每次最多檢查 100,000 個項目、回傳 1,000 個結果，回應含 `scannedEntries`、`skippedEntries`、`truncated` 與 `canWrite`。不回傳絕對路徑。 |
| `POST /api/folders` | 是 | 需有寫入權限；JSON `{ "shareId", "path", "name" }`。 |
| `POST /api/files/rename` | 是 | 需有寫入權限；JSON `{ "shareId", "path", "newName" }`；只在同一個 Nanako 資料空間內重新命名，不可重新命名根目錄或覆寫同名項目。 |
| `POST /api/files/move` | 是 | 需有寫入權限；JSON `{ "shareId", "path", "destinationPath" }`；移至同一個 Nanako 資料空間內的既有資料夾，不可移動根目錄、移入自身子資料夾或覆寫同名項目。 |
| `POST /api/files/copy` | 是 | 需有寫入權限；JSON `{ "shareId", "path", "destinationPath" }`；以串流方式複製檔案或整個資料夾至同一個資料空間，暫存完成後才發佈，不覆寫目的地；單次最多 100,000 個項目，遇到符號連結或特殊檔案會拒絕。 |
| `POST /api/upload?shareId=…&path=…&name=…` | 是 | 需有寫入權限；request body 為檔案內容，單檔上限 5 GiB。 |
| `GET /api/preview?shareId=…&path=…` | 是 | 需有讀取權限；提供允許清單中的圖片／音訊／影片 MIME，支援單一 `Range: bytes=start-end` 請求（回傳 `206`）。 |
| `GET /api/download?shareId=…&path=…` | 是 | 需有讀取權限；回傳檔案內容。 |
| `DELETE /api/files?shareId=…&path=…` | 是 | 需有寫入權限；將項目移至資源回收桶，不能刪除分享根目錄。 |
| `GET /api/trash?shareId=…` | 是 | 需有該分享資料夾寫入權限；列出待還原項目。 |
| `POST /api/trash/restore` | 是 | 需有該項目分享資料夾寫入權限；JSON `{ "id" }`。 |
| `DELETE /api/trash?id=…` | 是 | 僅管理員可永久刪除資源回收桶項目。 |
| `GET /api/users` | 是 | 僅管理員可列出使用者、啟用狀態與各資料空間權限。 |
| `POST /api/users` | 是 | 僅管理員；JSON `{ "username", "password", "permissions": [{ "shareId", "canRead", "canWrite" }] }`。 |
| `PATCH /api/users/{userId}` | 是 | 僅管理員；一般使用者可調整資料空間權限及 `isActive`；停用會立即撤銷該使用者所有工作階段。不可修改自己的帳號，也不可用此端點修改管理員帳號。 |
| `GET /api/network` | 是 | 回報目前本機服務資訊與網路介面清單；不會啟用區域網路連線或改變網路設定。 |
| `GET /api/smb/status` | 是 | 僅管理員；唯讀檢查 Windows `LanmanServer` 服務、TCP 445 是否正在監聽、`New-SmbShare` 命令是否可用，以及 Nanako 程序是否已提升。此為前置診斷，不會建立分享、啟停 Windows 服務或修改防火牆；`nanakoSmbReady` 目前固定為 `false`。 |
| `GET /api/system` | 是 | 僅管理員；查看本機電腦名稱、Windows 版本／組建、處理器、記憶體、Nanako 資料磁碟容量、網路介面及目前 Windows 身分、系統管理員群組與程序提升狀態。 |
| `POST /api/activity` | 是 | 記錄使用者開啟／切換 Nanako 畫面及視窗操作；JSON `{ "view", "action"? }`。`action` 可為 `open`、`focus`、`minimize`、`maximize`、`restore`、`close`、`move`、`preview`；省略時視為 `open`。僅接受已知畫面與操作代碼，管理畫面限管理員。 |
| `POST /api/archive/create` | 是 | 需有分享資料夾寫入權限；JSON `{ "shareId", "path" }`，在來源旁建立同名 ZIP。來源、暫存與輸出都限制在 Nanako 資料空間。 |
| `POST /api/archive/extract` | 是 | 需有分享資料夾寫入權限；JSON `{ "shareId", "path" }`，只接受 ZIP，解壓至同名新資料夾；不覆寫現有資料。拒絕路徑跳脫、符號連結、加密 ZIP、衝突路徑及超出大小／項目數限制的封存檔。 |
| `GET /api/archive/status` | 是 | 查詢目前使用者 ZIP 壓縮／解壓工作的階段、已處理位元組與項目數。 |
| `POST /api/archive/cancel` | 是 | 取消目前使用者的 ZIP 工作；成品發佈階段開始後會拒絕取消，以避免回報不明確的結果。 |
| `GET /api/vault/status` | 是 | 回傳目前使用者的加密空間是否已建立及已解鎖；不回傳金鑰或敏感中繼資料。 |
| `POST /api/vault/setup` | 是 | JSON `{ "password" }`；為目前 Nanako 使用者建立獨立 vault master key、密碼包覆資料及一次性復原金鑰。加密密碼需 12–256 字元；復原金鑰只在建立時顯示一次，使用者須自行離線保管。 |
| `POST /api/vault/unlock` | 是 | JSON `{ "password" }`；錯誤密碼回傳 `401`，錯誤 5 次後節流 15 分鐘並回傳 `429`。解鎖金鑰只在服務程序記憶體中，閒置 15 分鐘後鎖定。 |
| `POST /api/vault/recover` | 是 | JSON `{ "recoveryCode" }`；以一次性復原金鑰解鎖加密空間。復原金鑰無法復原時不能由管理員重設 vault 金鑰。 |
| `POST /api/vault/recovery-key` | 是 | 需要已解鎖；建立新的復原金鑰並更新包覆資料，回應只顯示新金鑰一次；舊金鑰立即失效。 |
| `POST /api/vault/password` | 是 | 需要已解鎖；JSON `{ "currentPassword", "newPassword" }`；變更包覆密碼但保留 master key 與既有加密物件。 |
| `POST /api/vault/lock` | 是 | 立即鎖定目前使用者加密空間；會取消進行中的加密／解密串流，作業清理完成後清除金鑰參照。 |
| `GET /api/vault/objects` | 是 | 需要加密空間已解鎖；只列出目前使用者的加密物件及解密後中繼資料。未解鎖回傳 `423`。 |
| `GET /api/vault/recovery` | 是 | 需要加密空間已解鎖；列出索引交易中斷的移入作業。比對來源檔案 SHA-256，回報原檔相符、已不存在、已變更或目前不可檢查；不會自行刪除來源。 |
| `POST /api/vault/recovery/{objectId}` | 是 | JSON `{ "action": "complete"\|"keep" }`。`complete` 只會在來源仍於 NanakoData 且內容雜湊與已加密版本一致時移除來源；來源已不存在時只結束復原標記；來源已變更或權限不足時拒絕。`keep` 保留一般檔案與密文，只清除待確認標記。 |
| `POST /api/vault/objects/import` | 是 | 需要加密空間已解鎖，且使用者對來源 Nanako 分享有讀寫權限；JSON `{ "shareId", "path" }`。只接受 NanakoData 中的一般檔案，串流加密並驗證後移除來源路徑；索引提交與來源移除由 SQLite 復原標記保護。若來源無法移除，回傳 `item.sourceRemovalPending: true`，應於解鎖後檢查復原清單。路徑外的檔案／磁碟不接受。 |
| `GET /api/vault/objects/import/status` | 是 | 回報目前使用者加密移入的階段、已讀取位元組與來源大小。 |
| `POST /api/vault/objects/import/cancel` | 是 | 取消尚未進入來源移除階段的加密移入；取消時保留來源並清理暫存密文。 |
| `GET /api/vault/objects/{objectId}/content` | 是 | 需要已解鎖且該物件屬於目前使用者；只提供允許清單中的圖片／音訊／影片 MIME，支援單一 byte-range。每個被讀取區塊都需通過 GCM 驗證；不產生明文暫存檔。 |
| `GET /api/vault/trash` | 是 | 需要已解鎖；只列出目前使用者加密空間資源回收筒中的解密後名稱與必要資訊。 |
| `DELETE /api/vault/objects/{objectId}` | 是 | 需要加密空間已解鎖；JSON `{ "confirmText": "移至資源回收桶" }`；將密文物件標記為刪除，仍以密文保存在 NanakoData。 |
| `POST /api/vault/trash/{objectId}/restore` | 是 | 需要加密空間已解鎖；還原該物件的索引狀態。 |
| `DELETE /api/vault/trash/{objectId}` | 是 | 需要加密空間已解鎖；JSON `{ "confirmText": "永久刪除" }`；明確確認後刪除索引、加密中繼資料 sidecar 與密文檔案。不承諾 SSD 安全抹除。 |
| `GET /api/vault/backups` | 是 | 需要加密空間已解鎖；列出可驗證的加密備份及無法驗證的備份標示。 |
| `POST /api/vault/backups` | 是 | 需要加密空間已解鎖；將索引、中繼資料、金鑰包覆資料及物件密文複製到 `NanakoData/.nanako-vault/{userId}/backups`；備份內容仍為密文。此為同一資料目錄內的還原點，不是異地備份。 |
| `POST /api/vault/backups/{backupId}/restore` | 是 | 需要加密空間已解鎖；先驗證備份清單、雜湊與物件認證，再補回缺少的加密物件；現有物件不覆寫。 |
| `DELETE /api/vault/backups/{backupId}` | 是 | 需要加密空間已解鎖；JSON `{ "confirmText": "刪除備份" }`；刪除指定 NanakoData 內的備份。 |
| `POST /api/vault/orphans/{objectId}` | 是 | 需要加密空間已解鎖；JSON `{ "confirmText": "永久刪除孤兒密文" }`；只能清理未被索引引用的密文／sidecar／暫存檔，索引重複檢查後才會執行。 |
| `POST /api/duplicates/scan` | 是 | 需有分享資料夾讀取權限；JSON `{ "shareId" }`；以非同步工作掃描 Nanako 管理範圍，回傳 `202` 與 `scanId`。每次最多檢查 100,000 個項目；同一位使用者同時僅可執行一項掃描。 |
| `GET /api/duplicates/scan?scanId=…` | 是 | 僅掃描建立者且仍有讀取權限者可讀取進度／結果；回傳狀態、進度、統計與已驗證重複群組。 |
| `DELETE /api/duplicates/scan?scanId=…` | 是 | 僅掃描建立者可取消進行中的掃描。 |
| `POST /api/duplicates/cleanup` | 是 | 需有分享資料夾寫入權限；JSON `{ "scanId", "groups": [{ "groupId", "keepPath" }] }`；重新驗證群組檔案後，將未選為保留項的副本逐筆移至資源回收桶。一次最多 200 組／1,000 個副本，回傳逐筆成功／失敗結果。 |
| `GET /api/audit-settings` | 是 | 僅管理員；回傳操作紀錄自動清除期限及允許選項（1、3、7、30、90、180、365 日）。 |
| `POST /api/audit-settings` | 是 | 僅管理員；JSON `{ "retentionDays" }`；調整保留期限後立即清理逾期紀錄。預設 30 日。 |
| `GET /api/audit-logs` | 是 | 僅管理員；回傳保留期限內最近 500 筆操作紀錄。 |
| `DELETE /api/audit-logs` | 是 | 僅管理員；JSON `{ "confirmText": "刪除所有紀錄" }`；刪除所有使用者操作紀錄。錯誤確認文字回傳 `400`。 |

`path` 是分享資料夾內的相對路徑；不可使用絕對路徑或跳脫路徑。名稱須符合 Windows 檔名限制。實際狀態碼與回應內容以 `src/server.mjs` 和 `test/server.test.mjs` 為準。

檔案 API 的根目錄固定為可攜式執行檔所在位置的 `NanakoData/data/files/<shareId>`；API 不接受外部路徑、磁碟代號或資料夾選擇請求。`/api/download` 只傳回該根目錄內的檔案；`DELETE /api/files` 與資源回收桶只操作 `NanakoData/data/trash`。相簿和播放器也只能讀取這些 Nanako 資料空間。Renderer 送入的 `path` 一律是分享資料空間內的相對路徑；伺服器會拒絕資料目錄中的符號連結／重新解析點。

`/api/preview` 目前只處理單一 byte range；不支援多段 range、縮圖或轉碼。音訊／影片能否播放取決於 Electron 內建 Chromium 支援的容器與編碼格式。播放器的相容性測試只能選取目前 Nanako 分享資料空間的檔案，並透過同一個受權限檢查的 Range API 串流播放；不會開啟檔案系統選擇器或讀取外部媒體路徑。

## 操作紀錄

使用者登入／登出、畫面切換、視窗開啟／切換／最小化／最大化／還原／移動／關閉、資料夾瀏覽、分類／相簿／播放清單搜尋、檔案匯入／下載／預覽／重新命名／移動／複製／移至回收桶、還原／永久刪除、使用者管理、SMB 前置狀態檢視、ZIP 壓縮／解壓縮、重複檔案掃描／整理及保留期限變更會記錄在 `NanakoData\data\metadata.sqlite`。批次操作逐項呼叫 API，因此每個成功或失敗的檔案動作分別留有紀錄。搜尋紀錄只保留分類名稱，不記錄使用者輸入的檔名查詢。管理員可查看所有帳號的操作紀錄；一般使用者不能查看、修改保留期限或刪除紀錄。每次開啟本機設定頁最多顯示最近 500 筆。

紀錄包含時間、使用者、操作、必要的目標名稱／相對路徑與成功／失敗結果；不儲存密碼、工作階段權杖或檔案內容。背景輪詢與影音播放的逐段 HTTP Range 請求不各自重複寫入。系統於啟動、每小時、調整期限及讀取紀錄時清除逾期資料。手動刪除須於 Nanako 防呆視窗輸入「刪除所有紀錄」，伺服器也會再次驗證確認文字；為確實清空，清除動作本身不會留在已刪除的紀錄中。

ZIP 使用單一 `zip.js` 套件串流建立／解壓；每次操作最多 10,000 個項目、解壓後 20 GiB，並拒絕壓縮比大於 1,000 的大型項目。支援工作階段進度與取消，失敗／取消時會移除 Nanako 暫存檔；測試包含 CRC 損毀拒絕、32 MiB 串流記憶體量測及 PowerShell `Compress-Archive`／`Expand-Archive` 互通。ZIP 不提供加密或密碼保護，也不處理加密空間物件。

複製操作採串流，不會把整個檔案讀入記憶體；複製資料夾時先量測項目數／檔案大小並檢查磁碟可用空間，再複製至同一目的資料夾下的隱藏暫存項目，成功後重新命名為正式項目，失敗時清理暫存。單次最多 100,000 個項目；介面目前逐項執行批次操作並回報部分成功，尚未提供進度、取消或大型資料夾的效能／記憶體量測。

## 帳號防護與 Windows 執行權限

登入錯誤以帳號及來源位址分組，15 分鐘內連續錯誤 5 次後暫停該組登入 15 分鐘；節流狀態保存在目前服務程序記憶體，重新啟動服務後重設。帳號停用會立即撤銷其現有工作階段。密碼變更需提供目前密碼，成功後撤銷同一帳號其他工作階段；密碼不會寫入操作紀錄。

管理員限定的 `GET /api/system` 會回報目前 Windows 執行身分、是否屬於系統管理員群組，以及程序目前是否處於高完整性（已提升）權限。Windows 帳號具系統管理員身分，不代表目前程序已提升。此狀態檢視已實作；需要系統管理員身分安裝的安裝程式與一般 Windows 使用者的執行方式仍待設計及驗收，現有可攜式封裝不會自行安裝或提升權限。

## 外部整合 API 的後續設計

正式開放前需建立 `/api/v1` 版本路徑、OpenAPI 規格、可撤銷的 API Token（scope 與到期日）、每個檔案操作的授權矩陣、速率／大小限制、稽核紀錄、TLS 與 Windows 防火牆設定流程。API Token 應由本機使用者建立，預設不授予管理員權限；撤銷後立即失效。區域網路服務需由使用者主動開啟並可隨時關閉。

