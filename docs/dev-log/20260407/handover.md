# EA Harness OSS 開発ログ

- 作成日: 2026-04-07
- 対象期間: 2026-04-06 から 2026-04-07
- 目的: 別チャットでそのまま引き継げるように、今回の問題と修正内容を整理して残す

## 1. 現在の到達状態

- ダッシュボードから Phase 0 -> 4 まで一通り実行できる状態
- 対象プロジェクト `4dec5fe4-7898-42a0-add9-fa09cb6bc458` は `completed`
- `spec.yaml`、EA ソース、`.ex5`、バックテスト結果、最適化結果、分析レポートまで生成済み
- UI は以前よりかなり日本語化され、初心者向けに見やすく改善済み

## 2. 対象プロジェクト

- Project ID: `4dec5fe4-7898-42a0-add9-fa09cb6bc458`
- Project Name: `20260416-1`
- Idea: `RSI逆張り`
- 現在状態: `currentPhase=4`, `status=completed`

主な成果物:

- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/spec.yaml`
- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/src/RSI逆張り_M15.mq5`
- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/analysis/backtest-summary.json`
- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/analysis/optimization_result.json`
- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/analysis/optimization_result.top20.json`
- `workspace/4dec5fe4-7898-42a0-add9-fa09cb6bc458/analysis/report.json`

## 3. 主な問題と修正履歴

### 3.1 ダッシュボード初期 UI

問題:

- Setup Wizard のレイアウトが崩れていた
- 初心者向けの説明が不足していた
- 生成された仕様書や分析結果がダッシュボードで見えなかった

修正:

- Setup Wizard を下段寄せにして見た目を整理
- README を初心者向けの日本語で全面更新
- Pipeline タブで `spec.yaml` を見られるように修正
- 分析タブを JSON 生表示からカード/表ベース表示へ修正
- 主要 UI 文言を日本語化

主な関連ファイル:

- `dashboard/index.html`
- `dashboard/css/style.css`
- `dashboard/js/app.js`
- `dashboard/js/pipeline-monitor.js`
- `dashboard/js/chat.js`
- `dashboard/js/analysis-viewer.js`
- `README.md`

### 3.2 Codex CLI 呼び出しエラー

問題:

- 古い実装が `--approval-mode` を使っており、`codex-cli 0.118.0` で失敗
- 古いサーバープロセスを見ていて、修正後コードが反映されていない時間があった

修正:

- `codex exec --full-auto` ベースに変更
- `--add-dir` を使って必要ディレクトリを明示
- 古い起動プロセスと `dist` 側起動の混線を整理

主な関連ファイル:

- `server/codex/agent.ts`

### 3.3 Phase 0 の日本語仕様書とチャット修正

問題:

- `spec.yaml` の値や説明が英語寄りだった
- チャット送信後の反応が見えにくかった
- 送信ボタンが見えにくかった

修正:

- Phase 0 プロンプトに「必ず日本語で出力」を追加
- 仕様変更時にチャットへ応答メッセージを返すようにした
- チャット UI の入力欄と送信ボタンを見やすく調整

主な関連ファイル:

- `server/codex/prompts/phase0.md`
- `server/orchestrator/phase-runner.ts`
- `dashboard/js/chat.js`
- `dashboard/css/style.css`

### 3.4 Phase 1 コンパイル成功を失敗と誤判定

問題:

- MetaEditor ログが `0 errors, 2 warnings` でも失敗扱いになっていた
- `.ex5` が生成済みでも compile retry loop に入っていた

修正:

- `0 errors` を正しく成功判定
- `.ex5` が存在する場合も成功判定に含めた

主な関連ファイル:

- `server/mt5/compiler.ts`

### 3.5 サーバー再起動後に `running` が残る問題

問題:

- サーバー再起動後にメモリ上の実行は消えるのに、JSON 状態だけ `running` のまま残ることがあった
- ダッシュボード上では動いているように見えるが、実際には止まっていた

修正:

- 起動時に `running` 状態の残骸を回収して `error` に戻す処理を追加

主な関連ファイル:

- `server/orchestrator/state.ts`
- `server/index.ts`

### 3.6 Phase 2 バックテスト起動

問題:

- `Expert=` の値が MT5 テスター仕様と合っていなかった
- `Report=` に絶対パスを使っていて MT5 側で扱いにくかった

修正:

- `Expert=EAHarness\\<project-id>.ex5` 形式に修正
- `Report=reports\\...` の相対パスに修正
- MT5 データフォルダに出たレポートを workspace 側へコピーする処理を追加

主な関連ファイル:

- `server/mt5/tester.ts`
- `server/orchestrator/phase-runner.ts`

### 3.7 Phase 3 最適化設定

問題:

- 一度 `no optimized parameter selected` で最適化結果が空になった
- 初期案のままだと組み合わせ数が多すぎた

修正:

- `optimization.ini` と `.set` 生成を見直し
- 最適化件数上限を `1000` に制限
- 最適化は `M1` + `Model=1` つまり「1分足OHLC」に固定
- 今回の仕様では理論値 `10,160,640` 通りから `864` 通りまで削減

主な関連ファイル:

- `server/orchestrator/phase-runner.ts`
- `server/mt5/tester.ts`
- `templates/optimization.ini.template`
- `templates/tester.ini.template`

### 3.8 最適化 XML パース不良

問題:

- `optimization_result.json` が `[object Object]` のような壊れた内容になっていた
- ダッシュボードでも `[object Object]` が表示されていた

修正:

- XML の `<Data>` を正しく読むように parser を修正
- `optimization_result.json` を再生成
- 分析タブでは主要指標 + パラメータ一覧で見せる形に変更

主な関連ファイル:

- `server/parser/optimizer-xml.ts`
- `dashboard/js/analysis-viewer.js`

### 3.9 Phase 4 分析タイムアウト

問題:

- Phase 4 の Codex 分析が `300000ms` でタイムアウトした

修正:

- Phase 4 は `optimization_result.top20.json` のみを使うよう変更
- Codex のタイムアウト下限を 10 分へ延長
- もし Codex が返らなくてもローカル要約で `report.json` を作るフォールバックを追加

主な関連ファイル:

- `server/orchestrator/phase-runner.ts`
- `server/codex/prompts/phase4.md`

### 3.10 AI 分析レポートの見やすさ改善

問題:

- `report.json` をそのまま表示していて、人間が読みにくかった

修正:

- 分析タブをレポート UI に変更
- 以下の順で読めるよう整理
  - 結論
  - 分析サマリー
  - 重要ポイント
  - 上位設定の見え方
  - パラメータ傾向
  - リスク評価
  - 信頼性の見方
  - 次にやること
- 生データは `details` にしまって必要時だけ見せる形へ変更

主な関連ファイル:

- `dashboard/js/analysis-viewer.js`
- `dashboard/css/style.css`

## 4. 現在の環境設定

`environment.yaml` の主要値:

- MT5 terminal: `C:/Program Files/XMTrading MT5/terminal64.exe`
- MT5 metaeditor: `C:/Program Files/XMTrading MT5/metaeditor64.exe`
- MT5 data folder: `C:/Users/ryohe/AppData/Roaming/MetaQuotes/Terminal/2FA8A7E69CED7DC259B1AD86A247F675`
- Codex command: `codex`
- Codex timeout: `300`
- Pipeline mode: `confirm`

## 5. まだ残っている課題

- 文字コードまわりはまだ完全には整理しきれていない
  - 一部の古いログや生成物に文字化けが残る可能性あり
- 最適化結果に、`spec.yaml` のレンジ外に見える値が混じることがある
  - 例: `overbought_level=81`, `oversold_level=36`, `atr_sl_multiplier=3.4`, `atr_tp_multiplier=2.9`
  - `.set` 生成か MT5 側の入力解釈にまだ詰める余地あり
- `backtest-summary.json` がサマリー以外の情報まで抱えすぎている
- `report.json` のスキーマは今後もう少し厳密に整理したい

## 6. 次チャットで最初に伝えるとよいこと

次チャットでは最初にこの内容を伝えると早い:

- 開発ログは `docs/dev-log/20260407/handover.md`
- 対象プロジェクト ID は `4dec5fe4-7898-42a0-add9-fa09cb6bc458`
- 現在は Phase 4 まで完走済みで `completed`
- 次の優先候補は以下
  - 最適化レンジ外の値が出る件を詰める
  - 文字コード/UTF-8 を全体で整理する
  - `backtest-summary.json` を本当にサマリーだけにする
  - 分析レポートの JSON スキーマを整理する

## 7. 補足

- 今回は「とにかく最後まで一周通す」ことを優先して調整した
- そのため、見た目と実行安定性はかなり改善したが、データ品質まわりは次の改善対象として残している
