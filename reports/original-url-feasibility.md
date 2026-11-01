# 元のPDF URLを維持できるか

調査日時: 2026-11-01T16:36:08+0900（JST）

## 結論

**可能。Chrome 151以降の公式 `chrome.mimeHandler` が、PDFの元URLをアドレスバーに残したまま拡張ビューアを表示する用途を直接サポートしている。** インストール済みGoogle Chromeのアプリ情報は `156.0.8078.80` で、バージョン要件を満たす。APIの実機呼び出し・登録・描画の動作確認はしていない。

現在は `background.js` のDNRリダイレクトとローカルファイル用の `tabs.update` により、`viewer.html?file=...` へ移動するためURLが変わる。URLの文字列だけを後から書き換える方法ではなく、PDFの受け取り方を変更する。

## 将来実装する場合の範囲

- `manifest.json`: `mime_types_handler` で `application/pdf` の表示先を登録する。まずトップレベルのPDFだけを対象にできる。
- `background.js`: 対応Chromeで既存リダイレクトを重ねないようにする。古いChromeとの互換方針も決める。
- `viewer.js`: `getStreamInfo()` の `originalUrl` を表示・引用用に使い、PDFデータは `streamUrl` から取得する。ストリームは1回だけ消費できるため、全体を読み取ってPDF.jsへ渡す構成にする。
- 既存の「通常のビューアで開く」や自動表示OFFの挙動を、公式のネイティブビューアへのフォールバックと整合させる。
- 埋め込み拒否の既存ガード、読み込み進捗、拡張APIの利用、他のPDFハンドラとの優先順位は実機で確認する。

## 参照した一次資料

[Chrome mimeHandler API](https://developer.chrome.com/docs/extensions/reference/api/mimeHandler) は、元URLの維持、ストリームの受け取りと1回限りの取得、ネイティブ表示へのフォールバック、Chrome 151より前の扱いを説明している。

[Chrome manifest: mime_types_handler](https://developer.chrome.com/docs/extensions/reference/manifest/mime-types-handler) は、PDFのハンドラ登録と、埋め込み対応を省略した場合にトップレベルだけを対象にする仕様を説明している。

## 今回の変更範囲

調査記録だけを追加した。`manifest.json`、`background.js`、`viewer.js`、インストール済み拡張機能は変更していない。ChromeのUIも操作していない。
