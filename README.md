# prsplit

大きなPull Requestを、AIを使ってレビューしやすいチェーンPRに自動分割するCLIツール。

## 課題

大量のfile changesを含むPRのレビューは、レビュアーにとって大きな負担です。prsplit は既存PRのdiffをAI（Claude / Codex）で解析し、レビューしやすい単位に自動分割してドラフトPRを作成します。

## 特徴

- **レイヤー単位の分割**: DB → ビジネスロジック → API → UI の順にPRを分割
- **チェーンPR**: 分割PRは依存関係を持ち、順序どおりにレビュー・マージ可能
- **自動ワークフロー**: GitHub Actionsで前PRのマージを監視し、次PRのdraft自動解除
- **インタラクティブ**: 分割案が気に入らなければ、指示を追加して再生成
- **完全一致保証**: 全分割PRマージ後の差分が元PRと完全一致

## インストール

```bash
npm install -g prsplit
```

**必要環境**: Node.js 20以上

## セットアップ

環境変数を設定してください:

```bash
# 必須
export GITHUB_TOKEN=ghp_xxxxx

# Claude を使う場合（デフォルト）
export ANTHROPIC_API_KEY=sk-ant-xxxxx

# Codex (OpenAI) を使う場合
export OPENAI_API_KEY=sk-xxxxx
```

## 使い方

### 基本的な使い方

```bash
# PR番号で指定（カレントディレクトリのリポジトリを使用）
prsplit 123

# PR URLで指定
prsplit https://github.com/owner/repo/pull/123
```

### オプション

```bash
prsplit <PR番号 or URL>
  --prompt "追加指示"         # 分割の方向性を指示
  --model claude|codex        # 使用するAIモデル（デフォルト: claude）
  --dry-run                   # 分割案のみ表示、PR作成はしない
```

### 実行例

```
$ prsplit 123
✓ 分割案を生成しました（3PR）
  1. feat/xxx-db-layer (4 files)
     feat: データベースマイグレーションとモデル追加
  2. feat/xxx-business-logic (6 files)
     feat: ビジネスロジックの実装
  3. feat/xxx-api-layer (3 files)
     feat: APIエンドポイントの追加

気に入りましたか？(y/n): n
✓ ドラフトPRを削除しました
再実行の指示を入力してください: ロジック層をさらに細かく分割して
✓ 分割案を生成しました（4PR）
...
```

### dry-runモード

```bash
prsplit 123 --dry-run
# → 分割案のみ表示。PRは作成されない。
```

### モデルの切り替え

```bash
prsplit 123 --model codex
```

## 分割ルール

1. **デフォルト戦略**: レイヤー単位（DB → ロジック → API → UI）
2. **フォールバック**: レイヤー構造が不明確な場合はAIが判断
3. **チェーン依存**: 分割PRは前PRのブランチをベースにする
4. **完全一致**: 全PR合算 = 元PRの差分

## マージの流れ

```
PR #1 (DB)  →  マージ  →  PR #2 (Logic) draft解除
PR #2 (Logic)  →  マージ  →  PR #3 (API) draft解除
PR #3 (API)  →  マージ  →  元PRを自動close
```

GitHub Actionsワークフローが自動生成され、前PRのマージを検知して次PRのdraftを解除します。

## 元PRの扱い

- 全分割PRマージ後、元PRは自動でcloseされます
- 元PRのブランチは残ります（動作確認用）
- 各分割PRの説明文に元PRのブランチ名が記載されます

## 開発

```bash
git clone https://github.com/prsplit/prsplit
cd prsplit
npm install
npm run build

# 開発モードで実行
npm run dev -- 123

# テスト
npm test
```

## ライセンス

MIT
# prsplit
