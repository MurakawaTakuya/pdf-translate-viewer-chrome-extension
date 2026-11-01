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

## 初回調査時の変更範囲

調査記録だけを追加した。`manifest.json`、`background.js`、`viewer.js`、インストール済み拡張機能は変更していない。ChromeのUIも操作していない。


## 実装追記: 2026-11-01T16:55:31+0900（JST）

その後の「URLを維持したままでやってみて」という指示により実装した。

- `manifest.json` にトップレベルの `application/pdf` ハンドラを登録した。埋め込みPDFは対象にしない。
- 対応Chromeでは既存のDNRリダイレクト規則を削除し、MIMEハンドラのON/OFFを既存の自動表示設定へ同期する。旧Chromeは従来のHTTPリダイレクト／ローカルファイル経路を維持する。
- `pdf-source.js` が元URLと1回限りの受信ストリームを扱う。全文バッファーをPDF.jsへ渡し、元URLはタイトル・引用・基準URLに使う。ストリームの実測バイト数を既存の青い進捗表示へつなぐ。元PDFを再取得しない。
- 通常ビューアへの復帰はバッファーを消費してから公式APIに引き渡す。PDFの解析・描画エラーでも復帰を試みる。MIMEハンドラだけがアンロードされる場合に備え、Chromeのタブズーム設定も復元する。
- 元URLを表示したタブでもポップアップが拡張ビューアを識別する。旧形式のビューアタブから通常ビューアへ戻す場合は、タブIDと元URLが一致する1回限りの引き継ぎを使う。
- 自動表示OFFでそのPDFだけを手動表示する場合は、全タブの設定を一時的にONへ変えず、従来の `viewer.html?file=...` を使う。この経路ではURLは変わる。
- 以前から開いている拡張URLのタブは自動移行しない。拡張を再読み込みし、元PDFのURLを開き直す必要がある。

ローカルテストは **172件成功、失敗0件**。ストリームの1回限りの取得、進捗、エラー、通常表示への引き継ぎ、旧Chrome、ON/OFF、ポップアップ判定、既存の翻訳・拡大縮小を確認した。英語の選択レイヤーも同じテスト群に含む。

ChromeのUI・インストール済み拡張は操作していない。実際のMIMEハンドラ登録、他拡張との優先順位、アドレスバー表示、マウスでの原文選択とコピーは実機未確認。Geminiのプロンプトと生成方式は今回変更していない。
