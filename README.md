# OH-TECH 情報科学習サイト

新潟県立長岡大手高等学校 R8 情報科学習用サイトです。情報Ⅰの4択問題を、分野・難易度・計算問題の有無で絞り込んで練習できます。

## 主なファイル構成

```text
index.html              # 画面本体
css/style.css           # デザイン
js/app.js               # 学習機能・記録管理
data/questions.js       # サイトが読み込む問題データ
questions.json          # 編集用の問題データ原本
docs/reports/           # 追加・修正時の作業レポート
scripts/                # 検査用スクリプト
```

## 問題データの注意

`questions.json` と `data/questions.js` は同じ285問に同期済みです。問題を追加・修正した場合は、両方の内容が一致しているか確認してください。

## 動作確認

```bash
node scripts/validate-data.mjs
node scripts/smoke-test.mjs
```


## 今回の整理・追加内容

- トップ画面に初回チュートリアルカードを追加しました。
- 「苦手問題とは？」の説明をトップ画面と使い方モーダルに追加しました。
- メダル条件を「各問題の直近10回の正答率」として明記しました。
- おすすめの学習順をトップ画面と使い方モーダルに追加しました。
- チュートリアルカードは「次回から隠す」で非表示にできます。

## 学習記録送信機能：answersシート対応

1問ごとの詳細ログをGoogleスプレッドシートの `answers` シートに記録できるようにするため、Apps Script更新用コードを `docs/apps-script-learning-log-with-answers.js` に同梱しています。

`answers` シートの1行目は次の列構成にしてください。

```text
日時 / 生徒ID / 学年 / 組 / 番号 / 問題ID / 分野 / 選択肢 / 正解 / 正誤
```
