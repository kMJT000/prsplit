/**
 * プロンプト定義
 */

import type { DiffFile } from "../utils/diff.js";

export interface SplitProposal {
  /** 分割PR一覧（レビュー順） */
  parts: SplitPart[];
}

export interface SplitPart {
  /** レビュー順序（1始まり） */
  order: number;
  /** ブランチ名（例: feat/xxx-db-layer） */
  branchName: string;
  /** PRタイトル */
  title: string;
  /** PR説明文 */
  description: string;
  /** この分割に含まれるファイルパス一覧 */
  files: string[];
  /** 分割理由 */
  rationale: string;
}

/**
 * diff分割用のシステムプロンプト
 */
export function buildSystemPrompt(): string {
  return `あなたはコードレビューの効率化を支援する専門家です。
大きなPull Requestのdiffを分析し、レビューしやすい単位に分割する提案を行います。

## 分割ルール
1. デフォルトの分割戦略はレイヤー単位です: DB（マイグレーション、モデル） → ビジネスロジック → API/コントローラー → UI/フロントエンド の順
2. レイヤー構造が明確でない場合は、以下の基準でフォールバック:
   - 機能単位（独立した機能ごと）
   - ファイルの依存関係（依存される側を先に）
   - 変更の種類（リファクタリング → 新機能 → テスト）
3. 各分割PRは前のPRに依存するチェーン構造にする
4. すべての分割PRがマージされると元PRの差分と完全一致すること
5. 1つのファイルは1つの分割PRにのみ含まれること（ファイル単位で分割）
6. 各PRは単独でビルドが通る状態にすること（可能な限り）

## 出力形式
以下のJSON形式で出力してください。JSON以外のテキストは一切含めないでください。

{
  "parts": [
    {
      "order": 1,
      "branchName": "feat/xxx-db-layer",
      "title": "feat: データベースマイグレーションとモデル追加",
      "description": "このPRでは...",
      "files": ["path/to/file1.ts", "path/to/file2.ts"],
      "rationale": "DB層の変更を先にレビューすることで..."
    }
  ]
}`;
}

/**
 * diff分割用のユーザープロンプトを構築する
 */
export function buildSplitPrompt(
  prTitle: string,
  prBody: string | null,
  files: DiffFile[],
  additionalInstruction?: string
): string {
  const fileList = files
    .map(
      (f) =>
        `- ${f.filename} (${f.status}, ${f.patch.split("\n").length}行)`
    )
    .join("\n");

  const diffContent = files
    .map((f) => `=== ${f.filename} (${f.status}) ===\n${f.patch}`)
    .join("\n\n");

  let prompt = `## 元PRの情報
タイトル: ${prTitle}
説明文: ${prBody ?? "(なし)"}

## 変更ファイル一覧 (${files.length}ファイル)
${fileList}

## diff内容
${diffContent}

上記のPRを、レビューしやすい単位に分割してください。`;

  if (additionalInstruction) {
    prompt += `\n\n## 追加指示\n${additionalInstruction}`;
  }

  return prompt;
}

/**
 * 複数チャンクの分割結果を統合するためのプロンプト
 */
export function buildMergePrompt(
  prTitle: string,
  prBody: string | null,
  chunkResults: SplitProposal[]
): string {
  const allParts = chunkResults.flatMap((r) => r.parts);
  const partsJson = JSON.stringify(allParts, null, 2);

  return `## 元PRの情報
タイトル: ${prTitle}
説明文: ${prBody ?? "(なし)"}

## 各チャンクの分割結果
以下は、大きなdiffを複数チャンクに分割してAIに送った結果です。
これらを統合して、一貫性のある分割提案にまとめてください。

${partsJson}

## 統合ルール
1. 同じレイヤー/目的のパーツはまとめる
2. レビュー順序を再構成する（DB → ロジック → API → UI）
3. ブランチ名を統一的な命名にする
4. ファイルの重複がないか確認する
5. 各PRの説明文を適切に統合する`;
}

/**
 * AIレスポンスからJSONをパースする
 */
export function parseAIResponse(response: string): SplitProposal {
  // コードブロック内のJSONを抽出
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : response.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    // バリデーション
    if (!parsed.parts || !Array.isArray(parsed.parts)) {
      throw new Error("AIレスポンスに 'parts' 配列が含まれていません。");
    }

    for (const part of parsed.parts) {
      if (!part.order || !part.branchName || !part.title || !part.files) {
        throw new Error(
          `分割パート "${part.branchName ?? "unknown"}" に必須フィールドが不足しています。`
        );
      }
    }

    return parsed as SplitProposal;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      throw new Error(
        `AIレスポンスのJSONパースに失敗しました。\n` +
          `レスポンス (先頭500文字): ${response.slice(0, 500)}`
      );
    }
    throw e;
  }
}
