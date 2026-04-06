# EA Harness OSS

EA Harness OSS は、MT5 の EA 研究をブラウザから進めるためのツールです。

初心者向けに言うと、「EA を作るための作業を、ダッシュボードから順番に進める仕組み」です。

## 何ができるのか

このツールでは、次の流れを 1 つの画面で扱います。

1. EA のアイデアを書く
2. AI に仕様を作らせる
3. AI に EA コードを作らせる
4. MetaEditor でコンパイルする
5. MT5 でバックテストする
6. MT5 で最適化する
7. AI に分析させる

現時点では、ダッシュボード、設定管理、パイプライン制御、MT5/Codex 接続確認の土台が動きます。

## フォルダの意味

- `dashboard/`
  ブラウザで見る画面です。
- `server/`
  裏側で動くサーバーです。
- `workspace/`
  作成したプロジェクトや生成結果が保存されます。
- `environment.yaml`
  MT5 や Codex の設定ファイルです。

## 必要なもの

- Node.js 20 以上
- MT5
- Codex CLI

## Codex の初期セットアップ

Codex は、インストールされているだけでは足りない場合があります。

最初に次を確認してください。

1. ターミナルで `codex --version` が通る
2. 必要なら `codex login` を実行してログインする
3. ログイン後に、もう一度 `codex --version` や `codex exec "Reply with OK"` のような簡単な実行を試す

このプロジェクトの `Test Codex` は、「`codex` コマンドが見つかるか」を確認するテストです。
つまり、コマンド自体は見つかっても、ログインや権限の問題で本番実行時に失敗することはあります。

もし Codex 実行で止まる場合は、まずターミナルで次を試してください。

```powershell
codex login
codex exec "Reply with OK"
```

## 最初の起動方法

このフォルダで次を実行します。

```powershell
npm install
npm run dev
```

そのあと、ブラウザで次を開きます。

```text
http://127.0.0.1:3000
```

## Setup Wizard とは

ダッシュボード下段の `Setup Wizard` は、最初の設定を確認する場所です。

ここで設定するものは次の意味です。

- `MT5 terminal64.exe`
  MT5 本体の場所
- `MT5 metaeditor64.exe`
  EA をコンパイルする MetaEditor の場所
- `MT5 data folder`
  MT5 がレポートや EA ファイルを保存する場所
- `Codex command`
  AI を呼ぶコマンド。通常は `codex`
- `Codex timeout (seconds)`
  AI の返答を待つ秒数
- `Server port`
  ダッシュボードのポート番号。通常は `3000`

## この PC で見つかった設定

この環境では、次の値を確認済みです。

```yaml
mt5:
  terminal_path: "C:/Program Files/XMTrading MT5/terminal64.exe"
  metaeditor_path: "C:/Program Files/XMTrading MT5/metaeditor64.exe"
  data_folder: "C:/Users/ryohe/AppData/Roaming/MetaQuotes/Terminal/2FA8A7E69CED7DC259B1AD86A247F675"

codex:
  command: "codex"
```

これらは `environment.yaml` に反映済みです。

## ダッシュボードで最初にやること

ブラウザを開いたら、次の順番で進めてください。

1. 下段の `Setup Wizard` を確認する
2. `Test MT5` を押す
3. `Test Codex` を押す
4. 問題なければ `Save Settings` を押す

ここでエラーが出なければ、基本設定は通っています。

## EA 研究を始める手順

1. 左の `New Project` に名前を入れる
2. その下に EA のアイデアを書く
3. `Create Project` を押す
4. 左の一覧から作成したプロジェクトを選ぶ
5. 右上の `Start Pipeline` を押す

アイデアの例:

```text
RSI逆張り USDJPY H1
```

## 仕様書をチャットで修正できるか

できます。

Phase 0 で `spec.yaml` が出たあとに、チャットで「ここを直して」と送れば、その内容を反映して仕様書を更新する想定です。

例:

```text
時間足を H1 ではなく M15 に変更してください
```

```text
損切りを固定幅ではなく ATR ベースに変更してください
```

```text
通貨ペアを USDJPY ではなく EURUSD に変更してください
```

確認モードでは、修正後の `spec.yaml` をダッシュボードで見てから `承認` できます。

## 画面の見方

- `Pipeline`
  今どのフェーズまで進んでいるかを見ます。
- `Chat`
  AI とやり取りする場所です。
- `Analysis`
  結果や分析内容を見る場所です。
- `Logs`
  裏側で起きたことの記録です。

## フェーズとは

このツールでは作業を 5 段階に分けています。

- `Phase 0`
  アイデアから仕様を作る
- `Phase 1`
  コード生成とコンパイル
- `Phase 2`
  バックテスト
- `Phase 3`
  最適化
- `Phase 4`
  分析と改善提案

## よくあるつまずき

- MT5 が見つからない
  Setup Wizard のパスが間違っている可能性があります。
- Codex が見つからない
  ターミナルで `codex --version` が通るか確認してください。
- 画面が開かない
  `npm run dev` が起動しているか確認してください。
- テストが止まる
  MT5 のデータフォルダやレポート出力先の調整が必要な場合があります。

## 開発用コマンド

```powershell
npm run dev
npm run check
npm run build
```
