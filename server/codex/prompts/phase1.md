spec.yamlの仕様に基づいてMQL5のEAコードを生成してください。

## ルール
- ea_base.mq5のテンプレート構造に従うこと
- エントリーロジックのみ変更し、共通足回りは維持
- input変数はspec.yamlのoptimization_paramsに対応させる
- コンパイルエラーが出ないよう型に注意

## 入力ファイル
- spec.yaml: 仕様書
- templates/ea_base.mq5: テンプレート

## 出力
- src/{ea_name}.mq5
