# Electron 媒體相容性初測

- 測試日期：2026-11-05（台灣時間）
- 執行方式：`npm run test:media`
- Electron：45.2.2
- Chromium：156.0.8078.80
- Node.js（Electron runtime）：24.22.2
- 平台：Windows x64
- 測試資料：Electron `MediaRecorder` 即時產生的短影音片段；不是實際使用者檔案。封裝後測試另外執行並確認會在可攜式程式目錄產生 JSON 報告。

另已用 `npm run package:win` 建置 Windows x64 可攜式 `.exe`，並從封裝後程式啟動相同測試模式。報告寫入執行檔旁 `NanakoData/media-compatibility-report.json`；封裝結果同樣通過 H.264、VP8、VP9、AV1、AAC/M4A 與 WebM/Opus，HEVC 仍無法解碼。封裝媒體測試本身沒有引入額外套件。

## 結果

| 格式 | Electron 合成片段實際播放 | 備註 |
| --- | --- | --- |
| MP4／H.264＋AAC | 通過 | 合成片段可播放。 |
| MP4／HEVC＋AAC | 未通過 | `canPlayType` 回報 `probably`、MediaRecorder 表示可產生，但實際解碼回報 `DECODER_ERROR_NOT_SUPPORTED`。 |
| WebM／VP8＋Opus | 通過 | 合成片段可播放。 |
| WebM／VP9＋Opus | 通過 | 合成片段可播放。 |
| WebM／AV1＋Opus | 通過 | 合成片段可播放。 |
| AAC／M4A | 通過 | 合成音訊可播放。 |
| WebM／Opus | 通過 | 合成音訊可播放。 |
| QuickTime／MOV | 尚未實測 | Chromium 未宣告支援；MediaRecorder 無法產生測試片段。 |
| MP3、WAV、Ogg／Opus、Ogg／Vorbis、FLAC | 尚未實測 | 能力 API 回報支援，但目前執行環境未提供這些格式的 MediaRecorder 合成方式。 |

## 判讀與後續

- `canPlayType`、MediaCapabilities 與 MediaRecorder 的格式回報不能單獨證明實際檔案可播放。本次影音格式中，MediaCapabilities 對影片回報不支援，但 H.264、VP8、VP9、AV1 合成片段實際可播；HEVC 則呈現反例。
- 這是可重現的 HEVC 測試缺口，但還沒有用真實使用者檔案或正式可攜式封裝確認需求，因此目前不加入 FFmpeg 或個別解碼器。
- 下一步應將具代表性的實際影音檔匯入 Nanako 資料空間，再用播放器與可攜式 `.exe` 逐一測試。需要 FFmpeg 時優先只評估媒體資訊與縮圖；轉檔播放另行決策。

